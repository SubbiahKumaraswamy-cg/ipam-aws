import { useState } from 'react';
import type {
  CloudAllocation,
  CloudAllocationInput,
  Environment,
  RegionGroup,
  AllocationStatus,
} from '@ipam/shared';
import {
  REGION_GROUPS,
  ALLOCATION_STATUSES,
  toCidrString,
  addressCount,
} from '@ipam/shared';
import { api } from '../api';
import { Modal } from './Modal';

interface Props {
  environment: Environment;
  onClose: () => void;
  onCreated: (row: CloudAllocation) => void;
}

export function NewAllocationDialog({ environment, onClose, onCreated }: Props) {
  const [regionGroup, setRegionGroup] = useState<RegionGroup>('EUROPE');
  const [iso, setIso] = useState('');
  const [country, setCountry] = useState('');
  const [cloudSpace, setCloudSpace] = useState('');
  const [mask, setMask] = useState('/16');
  const [currentRange, setCurrentRange] = useState('');
  const [status, setStatus] = useState<AllocationStatus>('Allocated');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);

  // Live preview of the normalised CIDR so users see the effect of the mask.
  const derivedCidr = toCidrString(cloudSpace, mask);
  const size = derivedCidr ? addressCount(derivedCidr) : 0;

  /** Warn (but do not block) when the new block overlaps an existing one. */
  async function checkOverlaps() {
    if (!derivedCidr) return;
    try {
      const overlaps = await api.findOverlaps(derivedCidr);
      setOverlapWarning(
        overlaps.length > 0
          ? `Overlaps ${overlaps.length} existing allocation(s): ` +
              overlaps
                .slice(0, 3)
                .map((o) => `${o.cidr} (${o.country ?? o.regionGroup})`)
                .join(', ') +
              (overlaps.length > 3 ? '…' : '')
          : null,
      );
    } catch {
      // Overlap check is advisory; ignore failures.
    }
  }

  async function submit() {
    if (!cloudSpace.trim() || !mask.trim()) {
      setError('CLOUD SPACE and MASK are both required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: CloudAllocationInput = {
        environment,
        regionGroup,
        iso: iso.trim() || null,
        country: country.trim() || null,
        cloudSpace: cloudSpace.trim(),
        mask: mask.trim(),
        currentRange: currentRange.trim() || null,
        status,
        remarks: remarks.trim() || null,
        tags: {},
      };
      onCreated(await api.createAllocation(input));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add ${environment} allocation`}
      subtitle="The CIDR is derived automatically from CLOUD SPACE and MASK."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Add allocation'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {overlapWarning && <div className="banner-info">{overlapWarning}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="region">Region grouping</label>
          <select
            id="region"
            value={regionGroup}
            onChange={(e) => setRegionGroup(e.target.value as RegionGroup)}
          >
            {REGION_GROUPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            value={status}
            onChange={(e) => setStatus(e.target.value as AllocationStatus)}
          >
            {ALLOCATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="iso">ISO</label>
          <input
            id="iso"
            type="text"
            value={iso}
            maxLength={8}
            placeholder="DE"
            onChange={(e) => setIso(e.target.value.toUpperCase())}
          />
        </div>
        <div className="field">
          <label htmlFor="country">COUNTRY</label>
          <input
            id="country"
            type="text"
            value={country}
            placeholder="Germany"
            onChange={(e) => setCountry(e.target.value)}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="cloudSpace">CLOUD SPACE</label>
          <input
            id="cloudSpace"
            type="text"
            value={cloudSpace}
            placeholder="10.20.0.0"
            onChange={(e) => setCloudSpace(e.target.value)}
            onBlur={() => void checkOverlaps()}
          />
        </div>
        <div className="field">
          <label htmlFor="mask">MASK</label>
          <input
            id="mask"
            type="text"
            value={mask}
            placeholder="/16 or 255.255.0.0"
            onChange={(e) => setMask(e.target.value)}
            onBlur={() => void checkOverlaps()}
          />
          <p className="field-hint">Accepts /16, 16 or 255.255.0.0.</p>
        </div>
      </div>

      <div className="field">
        <label>Derived CIDR</label>
        <p className="field-hint" style={{ fontSize: 13 }}>
          {derivedCidr ? (
            <>
              <code>{derivedCidr}</code> — {size.toLocaleString()} addresses
            </>
          ) : (
            <span style={{ color: 'var(--danger)' }}>
              Not a valid IPv4 network + mask yet.
            </span>
          )}
        </p>
      </div>

      <div className="field">
        <label htmlFor="currentRange">Current Range</label>
        <input
          id="currentRange"
          type="text"
          value={currentRange}
          placeholder="10.20.0.0/24 or 10.20.0.0 - 10.20.0.255"
          onChange={(e) => setCurrentRange(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="remarks">Remarks</label>
        <textarea
          id="remarks"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>
    </Modal>
  );
}
