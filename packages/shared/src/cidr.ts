/**
 * IPv4 / CIDR helpers.
 *
 * The source spreadsheet stores the network address ("CLOUD SPACE") and the
 * mask ("MASK") in separate columns, and the mask is written inconsistently -
 * sometimes as a prefix length ("/16", "16") and sometimes as a dotted-quad
 * netmask ("255.255.0.0"). These helpers normalise both forms into a single
 * canonical CIDR string so the database can use native `cidr` operators.
 */

/** Result of parsing/normalising a network + mask pair. */
export interface ParsedCidr {
  /** Canonical CIDR, e.g. "10.20.0.0/16". */
  cidr: string;
  /** Network address after masking, e.g. "10.20.0.0". */
  network: string;
  /** Prefix length, e.g. 16. */
  prefix: number;
  /** Broadcast / last address in the block. */
  broadcast: string;
  /** Total addresses in the block (2^(32-prefix)). */
  totalAddresses: number;
  /** Usable host addresses (total - 2, floored at 0 for /31 and /32). */
  usableAddresses: number;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad IPv4 address into a 32-bit unsigned integer. */
export function ipToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Convert a 32-bit unsigned integer into a dotted-quad IPv4 address. */
export function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/**
 * Interpret a mask written in any of the forms seen in the spreadsheet and
 * return the prefix length.
 *
 * Accepts: "/16", "16", " /16 ", "255.255.0.0", "255.252.0.0".
 * Returns null when the value cannot be interpreted.
 */
export function maskToPrefix(mask: string): number | null {
  const raw = String(mask ?? '').trim();
  if (!raw) return null;

  // Prefix forms: "/16" or "16"
  const prefixMatch = /^\/?(\d{1,2})$/.exec(raw);
  if (prefixMatch) {
    const prefix = Number(prefixMatch[1]);
    return prefix >= 0 && prefix <= 32 ? prefix : null;
  }

  // Dotted-quad netmask, e.g. "255.255.0.0"
  const asInt = ipToInt(raw);
  if (asInt === null) return null;

  // A valid netmask is a run of 1 bits followed by a run of 0 bits.
  const inverted = ~asInt >>> 0;
  if (((inverted + 1) & inverted) !== 0) return null; // not contiguous
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit--) {
    if ((asInt >>> bit) & 1) prefix++;
    else break;
  }
  return prefix;
}

/** Convert a prefix length into a dotted-quad netmask. */
export function prefixToMask(prefix: number): string | null {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const value = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(value);
}

/**
 * Normalise a network address plus mask into a canonical CIDR with derived
 * size information. Returns null when either input is unusable.
 *
 * Also tolerates a network that already carries its prefix ("10.20.0.0/16"),
 * in which case the embedded prefix wins if `mask` is empty.
 */
export function parseCidr(
  network: string | null | undefined,
  mask?: string | null,
): ParsedCidr | null {
  let addressPart = String(network ?? '').trim();
  if (!addressPart) return null;

  let prefix: number | null = null;

  // Handle "10.20.0.0/16" written directly in the address column.
  if (addressPart.includes('/')) {
    const [addr, embedded] = addressPart.split('/', 2);
    addressPart = addr.trim();
    prefix = maskToPrefix(embedded);
  }

  // An explicit mask column takes precedence when provided.
  if (mask !== undefined && mask !== null && String(mask).trim() !== '') {
    const fromMask = maskToPrefix(String(mask));
    if (fromMask !== null) prefix = fromMask;
  }

  if (prefix === null) return null;

  const addrInt = ipToInt(addressPart);
  if (addrInt === null) return null;

  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (addrInt & maskInt) >>> 0;
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  const broadcastInt = (networkInt + size - 1) >>> 0;

  return {
    cidr: `${intToIp(networkInt)}/${prefix}`,
    network: intToIp(networkInt),
    prefix,
    broadcast: intToIp(broadcastInt),
    totalAddresses: size,
    usableAddresses: size > 2 ? size - 2 : 0,
  };
}

/** Convenience wrapper returning just the canonical CIDR string, or null. */
export function toCidrString(
  network: string | null | undefined,
  mask?: string | null,
): string | null {
  return parseCidr(network, mask)?.cidr ?? null;
}

/** True when `inner` is fully contained within `outer`. */
export function cidrContains(outer: string, inner: string): boolean {
  const o = parseCidr(outer);
  const i = parseCidr(inner);
  if (!o || !i) return false;
  if (i.prefix < o.prefix) return false;
  const oStart = ipToInt(o.network);
  const iStart = ipToInt(i.network);
  if (oStart === null || iStart === null) return false;
  const oEnd = oStart + o.totalAddresses - 1;
  const iEnd = iStart + i.totalAddresses - 1;
  return iStart >= oStart && iEnd <= oEnd;
}

/** True when two CIDR blocks share any address. */
export function cidrOverlaps(a: string, b: string): boolean {
  const pa = parseCidr(a);
  const pb = parseCidr(b);
  if (!pa || !pb) return false;
  const aStart = ipToInt(pa.network);
  const bStart = ipToInt(pb.network);
  if (aStart === null || bStart === null) return false;
  const aEnd = aStart + pa.totalAddresses - 1;
  const bEnd = bStart + pb.totalAddresses - 1;
  return aStart <= bEnd && bStart <= aEnd;
}

/** Number of addresses in a CIDR, or 0 when unparseable. */
export function addressCount(cidr: string | null | undefined): number {
  if (!cidr) return 0;
  return parseCidr(cidr)?.totalAddresses ?? 0;
}

/**
 * Utilisation of a "current range" within an allocated block, as a fraction
 * between 0 and 1. Returns null when either value cannot be parsed.
 *
 * `currentRange` may be a CIDR ("10.20.0.0/24") or a hyphenated range
 * ("10.20.0.0 - 10.20.0.255"), both of which appear in the source sheet.
 */
export function utilisation(
  allocated: string | null | undefined,
  currentRange: string | null | undefined,
): number | null {
  const total = addressCount(allocated);
  if (!total) return null;
  const used = rangeSize(currentRange);
  if (used === null) return null;
  return Math.min(used / total, 1);
}

/**
 * Size of a range expressed either as a CIDR or as "start - end".
 * Returns null when unparseable.
 */
export function rangeSize(range: string | null | undefined): number | null {
  const raw = String(range ?? '').trim();
  if (!raw) return null;

  // Hyphenated range: "10.20.0.0 - 10.20.0.255"
  if (raw.includes('-')) {
    const [startRaw, endRaw] = raw.split('-', 2);
    const start = ipToInt(startRaw.trim());
    const end = ipToInt(endRaw.trim());
    if (start === null || end === null || end < start) return null;
    return end - start + 1;
  }

  const parsed = parseCidr(raw);
  return parsed ? parsed.totalAddresses : null;
}

/** Format a fraction as a percentage string, e.g. 0.25 -> "25.0%". */
export function formatPercent(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Validate that a string is a usable IPv4 CIDR. */
export function isValidCidr(value: string | null | undefined): boolean {
  return parseCidr(value) !== null;
}


/* -------------------------------------------------------------------------- */
/* Capacity planning within a master subnet                                   */
/* -------------------------------------------------------------------------- */

/** Usable host addresses in a block (total minus network and broadcast). */
export function usableHosts(cidr: string | null | undefined): number {
  const parsed = parseCidr(cidr ?? undefined);
  if (!parsed) return 0;
  return parsed.usableAddresses;
}

/** An inclusive range of 32-bit address values. */
export interface AddressRange {
  start: number;
  end: number;
}

/** Convert a CIDR into an inclusive numeric range. */
export function cidrToRange(cidr: string): AddressRange | null {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;
  const start = ipToInt(parsed.network);
  if (start === null) return null;
  return { start, end: start + parsed.totalAddresses - 1 };
}

/** Sort and coalesce overlapping/adjacent ranges. */
export function mergeRanges(ranges: AddressRange[]): AddressRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: AddressRange[] = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    // Merge when overlapping or directly adjacent.
    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Free gaps inside a master subnet, given the blocks already in use.
 *
 * Used ranges outside the master are ignored, and any that straddle its
 * boundary are clipped to it.
 */
export function freeRanges(
  masterCidr: string,
  usedCidrs: (string | null | undefined)[],
): AddressRange[] {
  const master = cidrToRange(masterCidr);
  if (!master) return [];

  const used = mergeRanges(
    usedCidrs
      .map((c) => (c ? cidrToRange(c) : null))
      .filter((r): r is AddressRange => r !== null)
      .filter((r) => r.end >= master.start && r.start <= master.end)
      .map((r) => ({
        start: Math.max(r.start, master.start),
        end: Math.min(r.end, master.end),
      })),
  );

  const gaps: AddressRange[] = [];
  let cursor = master.start;

  for (const range of used) {
    if (range.start > cursor) {
      gaps.push({ start: cursor, end: range.start - 1 });
    }
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= master.end) {
    gaps.push({ start: cursor, end: master.end });
  }
  return gaps;
}

/** Total number of free addresses inside a master subnet. */
export function freeAddressCount(
  masterCidr: string,
  usedCidrs: (string | null | undefined)[],
): number {
  return freeRanges(masterCidr, usedCidrs).reduce(
    (sum, gap) => sum + (gap.end - gap.start + 1),
    0,
  );
}

/**
 * Suggest the lowest correctly-aligned free block of the requested prefix
 * length inside a master subnet, or null when none is available.
 *
 * Subnets must start on an absolute multiple of their size, so a gap is only
 * usable if it contains such a boundary with room to spare. Walking the gaps
 * keeps this O(n log n) in the number of existing allocations rather than
 * iterating over candidate addresses.
 */
export function suggestNextSubnet(
  masterCidr: string,
  usedCidrs: (string | null | undefined)[],
  prefix: number,
): string | null {
  const master = parseCidr(masterCidr);
  if (!master) return null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  // A child can never be larger than its master.
  if (prefix < master.prefix) return null;

  const size = 2 ** (32 - prefix);

  for (const gap of freeRanges(masterCidr, usedCidrs)) {
    // Round the gap start up to the next multiple of the block size.
    const candidate = Math.ceil(gap.start / size) * size;
    if (candidate + size - 1 <= gap.end) {
      return `${intToIp(candidate)}/${prefix}`;
    }
  }
  return null;
}

/**
 * Largest prefix length (smallest block) that still fits in a master subnet,
 * useful for telling a requester what is actually available.
 * Returns null when nothing is free.
 */
export function largestFreeBlockPrefix(
  masterCidr: string,
  usedCidrs: (string | null | undefined)[],
): number | null {
  const master = parseCidr(masterCidr);
  if (!master) return null;

  for (let prefix = master.prefix; prefix <= 32; prefix++) {
    if (suggestNextSubnet(masterCidr, usedCidrs, prefix)) return prefix;
  }
  return null;
}

/** Format an address count compactly, e.g. 1048576 -> "1.0M". */
export function formatAddressCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
