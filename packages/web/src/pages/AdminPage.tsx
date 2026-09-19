import { useCallback, useEffect, useState } from 'react';
import type {
  Country,
  CustomField,
  CustomFieldEntity,
  CustomFieldType,
} from '@ipam/shared';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_TYPES,
  isValidFieldKey,
  toFieldKey,
} from '@ipam/shared';
import { api } from '../api';
import { Modal } from '../components/Modal';

/**
 * Administrator screen: define extra columns and delegate country ownership.
 * Both are the mechanisms for extending the portal without code changes.
 */
export function AdminPage() {
  const [tab, setTab] = useState<'fields' | 'owners'>('fields');

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Administration</h2>
          <p>
            Add columns for future use, and delegate write access for individual
            countries.
          </p>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'fields' ? 'tab-active' : ''}`}
          onClick={() => setTab('fields')}
        >
          Custom columns
        </button>
        <button
          type="button"
          className={`tab ${tab === 'owners' ? 'tab-active' : ''}`}
          onClick={() => setTab('owners')}
        >
          Country owners
        </button>
      </div>

      {tab === 'fields' ? <CustomFieldsPanel /> : <CountryOwnersPanel />}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Custom columns                                                             */
/* -------------------------------------------------------------------------- */

function CustomFieldsPanel() {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Include inactive so administrators can re-enable them.
      setFields(await api.listCustomFields(undefined, true));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(field: CustomField) {
    try {
      await api.updateCustomField(field.id, {
        entity: field.entity,
        fieldKey: field.fieldKey,
        label: field.label,
        dataType: field.dataType,
        options: field.options,
        position: field.position,
        required: field.required,
        active: !field.active,
        helpText: field.helpText,
      });
      setNotice(`${field.label} is now ${!field.active ? 'active' : 'hidden'}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(field: CustomField) {
    if (
      !window.confirm(
        `Delete the "${field.label}" column definition? Values already stored ` +
          'under this key remain in the database but stop being displayed. ' +
          'Hiding it instead is usually safer.',
      )
    ) {
      return;
    }
    try {
      await api.deleteCustomField(field.id);
      setNotice(`Deleted ${field.label}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="banner-success">{notice}</div>}

      <div className="toolbar">
        <span className="muted">
          Columns defined here appear on the matching grids and forms for everyone.
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNew(true)}
        >
          + Add column
        </button>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="centered">
          <div className="spinner" aria-label="Loading" />
        </div>
      ) : (
        CUSTOM_FIELD_ENTITIES.map((entity) => {
          const forEntity = fields.filter((f) => f.entity === entity);
          return (
            <div className="card" key={entity} style={{ marginBottom: 16 }}>
              <h3>{CUSTOM_FIELD_ENTITY_LABELS[entity]}</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Options</th>
                    <th>Required</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {forEntity.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <strong>{f.label}</strong>
                        {f.helpText && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {f.helpText}
                          </div>
                        )}
                      </td>
                      <td>
                        <code>{f.fieldKey}</code>
                      </td>
                      <td>{f.dataType}</td>
                      <td className="muted">
                        {f.options.length ? f.options.join(', ') : '—'}
                      </td>
                      <td>{f.required ? 'Yes' : 'No'}</td>
                      <td>
                        <span
                          className={`pill ${f.active ? 'pill-allocated' : 'pill-released'}`}
                        >
                          {f.active ? 'Active' : 'Hidden'}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => void toggleActive(f)}
                        >
                          {f.active ? 'Hide' : 'Show'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-link btn-link-danger"
                          onClick={() => void remove(f)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {forEntity.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No extra columns defined.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })
      )}

      {showNew && (
        <NewFieldDialog
          onClose={() => setShowNew(false)}
          onCreated={(f) => {
            setShowNew(false);
            setNotice(`Added column "${f.label}".`);
            void load();
          }}
        />
      )}
    </>
  );
}

function NewFieldDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (f: CustomField) => void;
}) {
  const [entity, setEntity] = useState<CustomFieldEntity>('child_subnet');
  const [label, setLabel] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [dataType, setDataType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [required, setRequired] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive the key from the label until the administrator overrides it.
  const effectiveKey = keyEdited ? fieldKey : toFieldKey(label);

  async function submit() {
    if (!label.trim()) {
      setError('A label is required.');
      return;
    }
    if (!isValidFieldKey(effectiveKey)) {
      setError(
        'The key must start with a lower-case letter and contain only ' +
          'lower-case letters, digits and underscores.',
      );
      return;
    }
    const options = optionsText
      .split(/[,\n]/)
      .map((o) => o.trim())
      .filter(Boolean);
    if (dataType === 'select' && options.length === 0) {
      setError('A "select" column needs at least one option.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createCustomField({
          entity,
          fieldKey: effectiveKey,
          label: label.trim(),
          dataType,
          options,
          position: 0,
          required,
          active: true,
          helpText: helpText.trim() || null,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a column"
      subtitle="The column appears on the chosen grid and its form. No deployment needed."
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
            {busy ? 'Saving…' : 'Add column'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="fentity">Applies to</label>
        <select
          id="fentity"
          value={entity}
          onChange={(e) => setEntity(e.target.value as CustomFieldEntity)}
        >
          {CUSTOM_FIELD_ENTITIES.map((e) => (
            <option key={e} value={e}>
              {CUSTOM_FIELD_ENTITY_LABELS[e]}
            </option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="flabel">Column label</label>
          <input
            id="flabel"
            type="text"
            value={label}
            placeholder="Cost Centre"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="fkey">Storage key</label>
          <input
            id="fkey"
            type="text"
            value={effectiveKey}
            onChange={(e) => {
              setKeyEdited(true);
              setFieldKey(e.target.value.toLowerCase());
            }}
          />
          <p className="field-hint">
            Cannot be changed later. {effectiveKey && !isValidFieldKey(effectiveKey) && (
              <span style={{ color: 'var(--danger)' }}>Invalid key.</span>
            )}
          </p>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ftype">Type</label>
          <select
            id="ftype"
            value={dataType}
            onChange={(e) => setDataType(e.target.value as CustomFieldType)}
          >
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="freq">Required</label>
          <select
            id="freq"
            value={required ? 'yes' : 'no'}
            onChange={(e) => setRequired(e.target.value === 'yes')}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </div>
      </div>

      {dataType === 'select' && (
        <div className="field">
          <label htmlFor="fopts">Options</label>
          <textarea
            id="fopts"
            rows={3}
            value={optionsText}
            placeholder="Low, Medium, High"
            onChange={(e) => setOptionsText(e.target.value)}
          />
          <p className="field-hint">Separate with commas or new lines.</p>
        </div>
      )}

      <div className="field">
        <label htmlFor="fhelp">Help text</label>
        <input
          id="fhelp"
          type="text"
          value={helpText}
          onChange={(e) => setHelpText(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Country owners                                                             */
/* -------------------------------------------------------------------------- */

function CountryOwnersPanel() {
  const [summary, setSummary] = useState<
    { userEmail: string; countries: string[] }[]
  >([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [owners, countryList] = await Promise.all([
        api.ownerSummary(),
        api.listCountries(),
      ]);
      setSummary(owners);
      setCountries(countryList);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeAll(userEmail: string) {
    if (!window.confirm(`Remove all country ownership from ${userEmail}?`)) return;
    try {
      await api.setCountryOwnerships(userEmail, []);
      setNotice(`Cleared ownership for ${userEmail}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="banner-success">{notice}</div>}

      <div className="banner banner-info" style={{ borderRadius: 8, marginBottom: 12 }}>
        A country owner must also be in the <strong>CountryOwner</strong> Cognito
        group. Assigning countries here without that group has no effect, and role
        changes take effect once the user signs in again.
      </div>

      <div className="toolbar">
        <span className="muted">
          {summary.length} user(s) with delegated country access.
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNew(true)}
        >
          + Assign countries
        </button>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="centered">
          <div className="spinner" aria-label="Loading" />
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Countries they may edit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.userEmail}>
                  <td>
                    <strong>{row.userEmail}</strong>
                  </td>
                  <td>
                    {row.countries.map((iso) => (
                      <span key={iso} className="pill pill-allocated" style={{ marginRight: 4 }}>
                        {iso}
                      </span>
                    ))}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => setEditingUser(row.userEmail)}
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      className="btn btn-link btn-link-danger"
                      onClick={() => void revokeAll(row.userEmail)}
                    >
                      Revoke all
                    </button>
                  </td>
                </tr>
              ))}
              {summary.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    Nobody has delegated country access yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(showNew || editingUser) && (
        <AssignCountriesDialog
          countries={countries}
          initialEmail={editingUser ?? ''}
          initialSelection={
            summary.find((s) => s.userEmail === editingUser)?.countries ?? []
          }
          onClose={() => {
            setShowNew(false);
            setEditingUser(null);
          }}
          onSaved={(email) => {
            setShowNew(false);
            setEditingUser(null);
            setNotice(`Updated ownership for ${email}.`);
            void load();
          }}
        />
      )}
    </>
  );
}

function AssignCountriesDialog({
  countries,
  initialEmail,
  initialSelection,
  onClose,
  onSaved,
}: {
  countries: Country[];
  initialEmail: string;
  initialSelection: string[];
  onClose: () => void;
  onSaved: (email: string) => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(iso: string) {
    setSelected((prev) =>
      prev.includes(iso) ? prev.filter((i) => i !== iso) : [...prev, iso],
    );
  }

  async function submit() {
    if (!email.trim()) {
      setError('An email address is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setCountryOwnerships(email.trim().toLowerCase(), selected);
      onSaved(email.trim().toLowerCase());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={initialEmail ? `Countries for ${initialEmail}` : 'Assign countries'}
      subtitle="The selection replaces any countries this user currently owns."
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
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="oemail">User email</label>
        <input
          id="oemail"
          type="email"
          value={email}
          placeholder="country.admin@compass-group.com"
          disabled={Boolean(initialEmail)}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="field-hint">
          Must match the email on their Cognito account.
        </p>
      </div>

      <div className="field">
        <label>Countries ({selected.length} selected)</label>
        <div className="checkbox-grid">
          {countries.map((c) => (
            <label key={c.iso} className="checkbox-item">
              <input
                type="checkbox"
                checked={selected.includes(c.iso)}
                onChange={() => toggle(c.iso)}
              />
              <span>
                {c.iso} — {c.name}
              </span>
            </label>
          ))}
        </div>
        {countries.length === 0 && (
          <p className="field-hint">Add countries first on the Countries page.</p>
        )}
      </div>
    </Modal>
  );
}
