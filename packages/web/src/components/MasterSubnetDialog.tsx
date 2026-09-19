import { useState } from 'react';
import type {
  Country,
  MasterSubnet,
  MasterSubnetInput,
  ProviderLocation,
  RegionGroup,
} from '@ipam/shared';
import {
  REGION_GROUPS,
  PROVIDER_LOCATIONS,
  toCidrString,
  addressCount,
  usableHosts,
} from '@ipam/shared';
import { api } from '../api';
import { useCustomFields } from '../useCustomFields';
import { Modal } from './Modal';
import type { Session } from '../auth';

interface Props {
  existing: MasterSubnet | null;
  countries: Country[];
  session: Session;
  onClose: () => void;
  onSaved: (row: MasterSubnet) => void;
}

export function MasterSubnetDialog({
  existing,
  countries,
  session,
  onClose,
  onSaved,
}: Props) {
  const custom = useCustomFields('master_subnet');

  const [cidr, setCidr] = useState(existing?.cidr ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [regionGroup, setRegionGroup] = useState<RegionGroup>(
    existing?.regionGroup ?? 'EUROPE',
  );
  const [countryIso, setCountryIso] = useState(existing?.countryIso ?? '');
  const [providerLocation, setProviderLocation] = useState<ProviderLocation | ''>(
    existing?.providerLocation ?? '',
  );
  const [description, setDescription] = useState(existing?.description ?? '');
  const [remarks, setRemarks] = useState(existing?.remarks ?? '');
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    existing?.attributes ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);

  const normalised = toCidrString(cidr);

  /** Advisory check; the database enforces the rule regardless. */
  async function checkOverlap() {
    if (!normalised) return;
    try {
      const hits = await api.masterOverlaps(normalised, existing?.id);
      setOverlapWarning(
        hits.length > 0
          ? `Overlaps ${hits.length} existing master subnet(s): ${hits
              .slice(0, 3)
              .map((h) => `${h.cidr} (${h.countryName ?? h.regionGroup})`)
              .join(', ')}${hits.length > 3 ? '…' : ''}`
          : null,
      );
    } catch {
      /* advisory only */
    }
  }

  async function submit() {
    if (!normalised) {
      setError('Enter a valid subnet, for example 10.20.0.0/16.');
      return;
    }
    // Region and Group level records require global rights.
    if (!countryIso && !session.canEditAll) {
      setError(
        'Only a global Author or Admin can create a master subnet without a country.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: MasterSubnetInput = {
        name: name.trim() || null,
        cidr: normalised,
        regionGroup,
        countryIso: countryIso || null,
        providerLocation: providerLocation || null,
        description: description.trim() || null,
        remarks: remarks.trim() || null,
        attributes,
      };
      const saved = existing
        ? await api.updateMaster(existing.id, input)
        : await api.createMaster(input);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Country owners may only attach masters to countries they own.
  const selectableCountries = session.canEditAll
    ? countries
    : countries.filter((c) => session.canEditCountry(c.iso));

  return (
    <Modal
      title={existing ? `Edit ${existing.cidr}` : 'Add a master subnet'}
      subtitle="Master subnets are the parent blocks that child allocations come from. They may never overlap."
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
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Add master subnet'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {overlapWarning && <div className="banner-error">{overlapWarning}</div>}

      <div className="field-row">
        <div className="field">
          <label htmlFor="mcidr">Master subnet (CIDR)</label>
          <input
            id="mcidr"
            type="text"
            value={cidr}
            placeholder="10.20.0.0/16"
            onChange={(e) => setCidr(e.target.value)}
            onBlur={() => void checkOverlap()}
          />
          <p className="field-hint">
            {normalised ? (
              <>
                <code>{normalised}</code> — {addressCount(normalised).toLocaleString()}{' '}
                addresses, {usableHosts(normalised).toLocaleString()} usable
              </>
            ) : (
              'Include the prefix, e.g. 10.20.0.0/16.'
            )}
          </p>
        </div>
        <div className="field">
          <label htmlFor="mname">Name</label>
          <input
            id="mname"
            type="text"
            value={name}
            placeholder="Germany primary"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="mregion">Region</label>
          <select
            id="mregion"
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
          <label htmlFor="mcountry">Country</label>
          <select
            id="mcountry"
            value={countryIso}
            onChange={(e) => setCountryIso(e.target.value)}
          >
            <option value="">— region / Group level —</option>
            {selectableCountries.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.iso} — {c.name}
              </option>
            ))}
          </select>
          <p className="field-hint">
            Leave blank for a region-wide or Group-level block (global roles only).
          </p>
        </div>
      </div>

      <div className="field">
        <label htmlFor="mprovider">Cloud provider / location</label>
        <select
          id="mprovider"
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

      {custom.fields.length > 0 && (
        <fieldset className="fieldset">
          <legend>Additional fields</legend>
          {custom.fields.map((field) => (
            <div className="field" key={field.id}>
              <label htmlFor={`mcf-${field.fieldKey}`}>
                {field.label}
                {field.required && ' *'}
              </label>
              {field.dataType === 'select' ? (
                <select
                  id={`mcf-${field.fieldKey}`}
                  value={String(attributes[field.fieldKey] ?? '')}
                  onChange={(e) =>
                    setAttributes({ ...attributes, [field.fieldKey]: e.target.value })
                  }
                >
                  <option value="">— none —</option>
                  {field.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`mcf-${field.fieldKey}`}
                  type={
                    field.dataType === 'number'
                      ? 'number'
                      : field.dataType === 'date'
                        ? 'date'
                        : 'text'
                  }
                  value={String(attributes[field.fieldKey] ?? '')}
                  onChange={(e) =>
                    setAttributes({ ...attributes, [field.fieldKey]: e.target.value })
                  }
                />
              )}
            </div>
          ))}
        </fieldset>
      )}

      <div className="field">
        <label htmlFor="mdesc">Description</label>
        <input
          id="mdesc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="mremarks">Remarks</label>
        <textarea
          id="mremarks"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>
    </Modal>
  );
}
