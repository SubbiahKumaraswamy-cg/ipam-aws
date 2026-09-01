import { useState } from 'react';
import { Modal } from './Modal';

interface ImportDialogProps {
  title: string;
  /** Column headers the importer understands, shown as guidance. */
  expectedHeaders: string[];
  onClose: () => void;
  onImport: (csv: string) => Promise<{ inserted?: number; updated?: number; total: number }>;
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
  const [result, setResult] = useState<string | null>(null);

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
      const r = await onImport(csv);
      const parts = [`${r.total} row(s) processed`];
      if (r.inserted !== undefined) parts.push(`${r.inserted} added`);
      if (r.updated !== undefined) parts.push(`${r.updated} updated`);
      setResult(parts.join(' · '));
      setCsv('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
      {result && <div className="banner-success">{result}</div>}

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
