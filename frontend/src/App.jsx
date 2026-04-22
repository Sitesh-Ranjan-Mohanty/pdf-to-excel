import React, { useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function App() {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [fileId, setFileId] = useState('');
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState('Select an invoice image or PDF to begin.');
  const [loading, setLoading] = useState(false);

  const canDownload = useMemo(() => Boolean(fileId), [fileId]);

  const onFileChange = (event) => {
    const nextFile = event.target.files?.[0] || null;
    setFile(nextFile);
    setRows([]);
    setFileId('');
    setFileName('');
    setStatus(nextFile ? `Ready to scan: ${nextFile.name}` : 'No file selected.');
  };

  const scanInvoice = async () => {
    if (!file) {
      setStatus('Please choose an invoice image or PDF first.');
      return;
    }

    setLoading(true);
    setStatus('Scanning invoice and generating Excel...');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_BASE}/api/invoices/scan`, {
        method: 'POST',
        body: formData,
      });

      const contentType = response.headers.get('content-type') || '';
      const responseText = await response.text();
      let payload = {};
      if (contentType.includes('application/json') && responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          payload = {};
        }
      }

      if (!response.ok) {
        throw new Error(payload.error || responseText || 'Scan failed.');
      }

      setRows(payload.rows || []);
      setFileId(payload.fileId || '');
      setFileName(payload.fileName || 'invoice.xlsx');
      setStatus(
        payload.warning || 'Invoice scanned successfully. Preview is ready.'
      );
    } catch (error) {
      setRows([]);
      setFileId('');
      setFileName('');
      setStatus(
        error.message ||
          'Could not reach the server. Ensure both backend (3000) and frontend (5173) are running.'
      );
    } finally {
      setLoading(false);
    }
  };

  const downloadExcel = () => {
    if (!fileId) {
      setStatus('Scan an invoice first to enable download.');
      return;
    }

    const link = document.createElement('a');
    link.href = `${API_BASE}/api/invoices/download/${fileId}`;
    link.download = fileName || 'invoice.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const hasTable = rows.length > 0;

  return (
    <main className="page">
      <section className="panel">
        <h1>Invoice OCR to Excel</h1>
        <p className="subtitle">Scan invoices, preview extracted rows, and download an Excel file.</p>

        <div className="controls">
          <input
            type="file"
            accept=".pdf,image/*"
            onChange={onFileChange}
            disabled={loading}
          />
          <button type="button" onClick={scanInvoice} disabled={loading || !file}>
            {loading ? 'Scanning...' : 'Scan Invoice'}
          </button>
          <button type="button" onClick={downloadExcel} disabled={!canDownload || loading}>
            Download Excel
          </button>
        </div>

        <p className="status">{status}</p>

        {hasTable ? (
          <div className="tableWrap">
            <table>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`c-${rowIndex}-${cellIndex}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyState">Preview table will appear here after scan.</div>
        )}
      </section>
    </main>
  );
}

export default App;
