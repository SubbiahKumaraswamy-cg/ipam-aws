import { useEffect, useMemo, useState } from 'react';
import type {
  ChildSubnet,
  ChildSubnetInput,
  MasterSubnet,
  DeploymentEnvironment,
  ProviderLocation,
  SubnetStatus,
} from '@ipam/shared';
import {
  DEPLOYMENT_ENVIRONMENTS,
  PROVIDER_LOCATIONS,
  SUBNET_STATUSES,
  toCidrString,
  usableHosts,
  addressCount,
} from '@ipam/shared';
import { api } from '../api';
import { useCustomFields } from '../useCustomFields';
import { Modal } from './Modal';
import type { Session } from '../auth';

interface Props {
  existing: ChildSubnet | null;
  masters: MasterSubnet[];
  session: Session;
  defaultMasterId?: string;
  onClose: () => void;
  onSaved: (row: ChildSubnet) => void;
}

/** Today's date as an ISO string, used to prefill the request date. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ChildSubnetDialog({
  existing,
  masters,
  session,
  defaultMasterId,
  onClose,
  onSaved,
}: Props) {
  const custom = useCustomFields('child_subnet');

  // Only offer masters the user is actually allowed to write.
  const writableMasters = useMemo(
    () => masters.filter((m) => session.canEditCountry(m.countryIso)),
    [masters, session],
  );

  const [masterSubnetId, setMasterSubnetId] = useState(
    existing?.masterSubnetId ?? defaultMasterId ?? writableMasters[0]?.id ?? '',
  );
  const [cidr, setCidr] = useState(existing?.cidr ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [requestorName, setRequestorName] = useState(
    existing?.requestorName ?? session.email,
  );
  const [requestDate, setRequestDate] = useState(
    existing?.requestDate ?? today(),
  );
  const [allocatedDate, setAllocatedDate] = useState(
    existing?.allocatedDate ?? '',
  );
  const [justification, setJustification] = useState(existing?.justification ?? '');
  const [technicalOwner, setTechnicalOwner] = useState(
    existing?.technicalOwner ?? '',
  );
  const [environment, setEnvironment] = useState<DeploymentEnvironment | ''>(
    existing?.environment ?? '',
  );
  const [providerLocation, setProviderLocation] = useState<ProviderLocation | ''>(
    existing?.providerLocation ?? '',
  );
  const [status, setStatus] = useState<SubnetStatus>(existing?.status ?? 'Reserved');
  const [remarks, setRemarks] = useState(existing?.remarks ?? '');
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    existing?.attributes ?? {},
  );

  const [prefix, setPrefix] = useState('24');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const master = masters.find((m) => m.id === masterSubnetId);
  const normalised = toCidrString(cidr);

  // Warn early when the range sits outside the chosen master.
  const outsideMaster = useMemo(() => {
    if (!normalised || !master) return false;
    const child = toCidrString(normalised);
    const parent = toCidrString(master.cidr);
    if (!child || !parent) return false;
    // Reuse the shared containment helper via a cheap numeric comparison.
    return !isWithin(parent, child);
  }, [normalised, master]);

  /** Ask the server for the lowest free block of the requested size. */
  async function suggest() {
    if (!masterSubnetId) {
      setError('Choose a master subnet first.');
      return;
    }
    const wanted = Number(prefix);
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > 32) {
      setError('Prefix must be a whole number between 0 and 32.');
      return;
    }
    setSuggesting(true);
    setError(null);
    setSuggestionNote(null);
    try {
      const report = await api.freeSpace(masterSubnetId, wanted);
      if (report.suggestion) {
        setCidr(report.suggestion);
        setSuggestionNote(
          `Suggested ${report.suggestion} — the lowest free /${wanted} in ${report.masterCidr}.`,
        );
      } else {
        setSuggestionNote(
          report.largestAvailablePrefix === null
            ? `${report.masterCidr} is fully allocated.`
            : `No free /${wanted} available. The largest free block is a /${report.largestAvailablePrefix}.`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function submit() {
    if (!masterSubnetId) {
      setError('A master subnet is required.');
      return;
    }
    if (!normalised) {
      setError('Enter a valid subnet, for example 10.20.1.0/24.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: ChildSubnetInput = {
        masterSubnetId,
        cidr: normalised,
        name: name.trim() || null,
        requestorName: requestorName.trim() || null,
        requestDate: requestDate || null,
        allocatedDate: allocatedDate || null,
        justification: justification.trim() || null,
        technicalOwner: technicalOwner.trim() || null,
        environment: environment || null,
        providerLocation: providerLocation || null,
        status,
        remarks: remarks.trim() || null,
        attributes,
      };
      const saved = existing
        ? await api.updateChild(existing.id, input)
        : await api.createChild(input);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Default the allocated date when the status becomes Allocated.
  useEffect(() => {
    if (status === 'Allocated' && !allocatedDate) setAllocatedDate(today());
  }, [status, allocatedDate]);

  return (
    <Modal
      title={existing ? `Edit ${existing.cidr}` : 'Request a child subnet'}
      subtitle={
        master
          ? `Inside ${master.cidr}${
              master.countryName ? ` · ${master.countryName}` : ''
            } — ${master.availableAddresses.toLocaleString()} addresses available`
          : 'Choose a master subnet to allocate from'
      }
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
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create allocation'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {suggestionNote && <div className="banner-success">{suggestionNote}</div>}
      {outsideMaster && (
        <div className="banner-error">
          {normalised} is not inside the selected master subnet {master?.cidr}.
        </div>
      )}

      <div className="field">
        <label htmlFor="master">Master subnet</label>
        <select
          id="master"
          value={masterSubnetId}
          onChange={(e) => setMasterSubnetId(e.target.value)}
        >
          <option value="">— select —</option>
          {writableMasters.map((m) => (
            <option key={m.id} value={m.id}>
              {m.cidr} · {m.countryName ?? m.regionGroup} (
              {m.availableAddresses.toLocaleString()} free)
            </option>
          ))}
        </select>
        {writableMasters.length === 0 && (
          <p className="field-hint" style={{ color: 'var(--danger)' }}>
            You do not have write access to any master subnet.
          </p>
        )}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="cidr">Child subnet (CIDR)</label>
          <input
            id="cidr"
            type="text"
            value={cidr}
            placeholder="10.20.1.0/24"
            onChange={(e) => setCidr(e.target.value)}
          />
          <p className="field-hint">
            {normalised ? (
              <>
                <code>{normalised}</code> — {addressCount(normalised).toLocaleString()}{' '}
                addresses, {usableHosts(normalised).toLocaleString()} usable hosts
              </>
            ) : (
              'Enter a range, or have one suggested.'
            )}
          </p>
        </div>
        <div className="field">
          <label htmlFor="prefix">Suggest a free /</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="prefix"
              type="number"
              min={0}
              max={32}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              style={{ width: 80 }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void suggest()}
              disabled={suggesting || !masterSubnetId}
            >
              {suggesting ? '…' : 'Suggest'}
            </button>
          </div>
          <p className="field-hint">Finds the lowest free, correctly aligned block.</p>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            type="text"
            value={name}
            placeholder="DE Prod web tier"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            value={status}
            onChange={(e) => setStatus(e.target.value as SubnetStatus)}
          >
            {SUBNET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="fieldset">
        <legend>Request details</legend>

        <div className="field-row">
          <div className="field">
            <label htmlFor="requestor">Requestor name</label>
            <input
              id="requestor"
              type="text"
              value={requestorName}
              onChange={(e) => setRequestorName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="owner">Technical owner</label>
            <input
              id="owner"
              type="text"
              value={technicalOwner}
              placeholder="team@compass-group.com"
              onChange={(e) => setTechnicalOwner(e.target.value)}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="reqDate">Request date</label>
            <input
              id="reqDate"
              type="date"
              value={requestDate}
              onChange={(e) => setRequestDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="allocDate">Allocated date</label>
            <input
              id="allocDate"
              type="date"
              value={allocatedDate}
              onChange={(e) => setAllocatedDate(e.target.value)}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="env">Environment</label>
            <select
              id="env"
              value={environment}
              onChange={(e) =>
                setEnvironment(e.target.value as DeploymentEnvironment | '')
              }
            >
              <option value="">— none —</option>
              {DEPLOYMENT_ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="provider">Cloud provider / location</label>
            <select
              id="provider"
              value={providerLocation}
              onChange={(e) =>
                setProviderLocation(e.target.value as ProviderLocation | '')
              }
            >
              <option value="">— none —</option>
              {PROVIDER_LOCATIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="justification">Justification / purpose</label>
          <textarea
            id="justification"
            rows={2}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
          />
        </div>
      </fieldset>

      {custom.fields.length > 0 && (
        <fieldset className="fieldset">
          <legend>Additional fields</legend>
          {custom.fields.map((field) => (
            <div className="field" key={field.id}>
              <label htmlFor={`cf-${field.fieldKey}`}>
                {field.label}
                {field.required && ' *'}
              </label>
              {field.dataType === 'select' ? (
                <select
                  id={`cf-${field.fieldKey}`}
                  value={String(attributes[field.fieldKey] ?? '')}
                  onChange={(e) =>
                    setAttributes({
                      ...attributes,
                      [field.fieldKey]: e.target.value,
                    })
                  }
                >
                  <option value="">— none —</option>
                  {field.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : field.dataType === 'boolean' ? (
                <select
                  id={`cf-${field.fieldKey}`}
                  value={String(attributes[field.fieldKey] ?? '')}
                  onChange={(e) =>
                    setAttributes({
                      ...attributes,
                      [field.fieldKey]: e.target.value === 'true',
                    })
                  }
                >
                  <option value="">— none —</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  id={`cf-${field.fieldKey}`}
                  type={
                    field.dataType === 'number'
                      ? 'number'
                      : field.dataType === 'date'
                        ? 'date'
                        : 'text'
                  }
                  value={String(attributes[field.fieldKey] ?? '')}
                  onChange={(e) =>
                    setAttributes({
                      ...attributes,
                      [field.fieldKey]: e.target.value,
                    })
                  }
                />
              )}
              {field.helpText && <p className="field-hint">{field.helpText}</p>}
            </div>
          ))}
        </fieldset>
      )}

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

/** Numeric containment check for the inline warning. */
function isWithin(outer: string, inner: string): boolean {
  const parse = (cidr: string) => {
    const [addr, bits] = cidr.split('/');
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return null;
    const value =
      ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const prefix = Number(bits);
    const size = 2 ** (32 - prefix);
    return { start: value, end: value + size - 1 };
  };
  const o = parse(outer);
  const i = parse(inner);
  if (!o || !i) return true; // Do not warn on unparseable input.
  return i.start >= o.start && i.end <= o.end;
}
