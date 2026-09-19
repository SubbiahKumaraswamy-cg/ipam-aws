import { useState } from 'react';
import { Modal } from './Modal';

/** Shape returned by the various import endpoints. */
export interface ImportOutcome {
  total: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  /** Per-row reasons for rows that could not be stored. */
  errors?: string[];
}

interface ImportDialogProps {
  title: string;
  /** Column headers the importer understands, shown as guidance. */
  expectedHeaders: string[];
  onClose: () => void;
  onImport: (csv: string) => Promise<ImportOutcome>;
}

/**
 * CSV import dialog. Accepts a pasted block of CSV or a chosen file, so users
 * can copy straight out of the existing spreadsheet.
 */
export function ImportDialog({
  title,
  expectedHeaders,
  onClose,
  onImport,
}: ImportDialogProps) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);

  async function handleFile(file: File) {
    setCsv(await file.text());
    setError(null);
  }

  async function submit() {
    if (!csv.trim()) {
      setError('Paste some CSV or choose a file first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await onImport(csv);
      setResult(outcome);
      // Keep the input when rows were skipped so it can be corrected and retried.
      if (!outcome.skipped) setCsv('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = result
    ? [
        `${result.total} row(s) submitted`,
        result.inserted !== undefined ? `${result.inserted} added` : null,
        result.updated !== undefined ? `${result.updated} updated` : null,
        result.skipped ? `${result.skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Modal
      title={title}
      subtitle="Paste CSV copied from the spreadsheet, or choose a .csv file."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className={result.skipped ? 'banner-error' : 'banner-success'}>
          <div>{summary}</div>
          {result.errors && result.errors.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {result.errors.slice(0, 15).map((message) => (
                <li key={message}>{message}</li>
              ))}
              {result.errors.length > 15 && (
                <li>…and {result.errors.length - 15} more.</li>
              )}
            </ul>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="csv-file">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="csv-text">…or paste CSV</label>
        <textarea
          id="csv-text"
          className="csv-input"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={expectedHeaders.join(',')}
          spellCheck={false}
        />
        <p className="field-hint">
          Recognised columns: <code>{expectedHeaders.join(', ')}</code>. Existing
          rows with the same key are updated rather than duplicated.
        </p>
      </div>
    </Modal>
  );
}
