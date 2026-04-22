const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

const runtimeWritableBase = process.env.VERCEL ? '/tmp' : __dirname;
const uploadDir = path.join(runtimeWritableBase, 'uploads');
const outputDir = path.join(runtimeWritableBase, 'generated');

for (const dir of [uploadDir, outputDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const upload = multer({ dest: uploadDir });
const downloadRegistry = new Map();
const PDF_PAGE_MARKER_RE = /^--\s*\d+\s+of\s+\d+\s*--$/i;

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);
app.use(express.json());

const splitLineToRow = (line) => {
  if (PDF_PAGE_MARKER_RE.test(line)) {
    return [];
  }

  const strongSplit = line
    .split(/\s{2,}|\t+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (strongSplit.length > 1) {
    return strongSplit;
  }

  const fallback = [line.trim()].filter(Boolean);

  return fallback;
};

const extractRowsFromText = (text) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => splitLineToRow(line))
    .filter((row) => row.length > 0);
};

const writeWorkbook = (rows, filename) => {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Invoices');

  const outputPath = path.join(outputDir, filename);
  XLSX.writeFile(workbook, outputPath);
  return outputPath;
};

const extractRowsFromTableResult = (tableResult) => {
  if (!tableResult?.pages?.length) {
    return [];
  }

  const tableRows = [];

  for (const page of tableResult.pages) {
    if (!page.tables?.length) {
      continue;
    }

    for (const table of page.tables) {
      for (const row of table) {
        const cleaned = row.map((cell) => String(cell || '').trim());
        if (cleaned.some(Boolean)) {
          tableRows.push(cleaned);
        }
      }
    }
  }

  return tableRows;
};

const normalizeRowKey = (row) =>
  row
    .map((cell) => String(cell || '').trim())
    .join('|')
    .toLowerCase();

const mergeUniqueRows = (...rowGroups) => {
  const merged = [];
  const seen = new Set();

  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const cleaned = row.map((cell) => String(cell || '').trim()).filter((cell) => cell !== '');
      if (!cleaned.length) {
        continue;
      }
      const key = normalizeRowKey(cleaned);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(cleaned);
    }
  }

  return merged;
};

const rowContentScore = (rows) => {
  if (!rows.length) {
    return 0;
  }

  const meaningfulRows = rows.filter((row) => {
    const text = row.join(' ').trim();
    if (!text) {
      return false;
    }
    if (PDF_PAGE_MARKER_RE.test(text)) {
      return false;
    }
    return text.replace(/[^a-zA-Z0-9]/g, '').length >= 8;
  });

  return meaningfulRows.length;
};

const ocrPdfPages = async (parser) => {
  const screenshots = await parser.getScreenshot({
    imageBuffer: true,
    imageDataUrl: false,
    scale: 2,
  });

  const allRows = [];
  for (const page of screenshots.pages || []) {
    if (!page.data) {
      continue;
    }
    const ocrResult = await Tesseract.recognize(Buffer.from(page.data), 'eng');
    const rows = extractRowsFromText(ocrResult.data?.text || '');
    allRows.push(...rows);
  }

  return allRows;
};

const ocrPdfEmbeddedImages = async (parser) => {
  const imageResult = await parser.getImage({
    imageBuffer: true,
    imageDataUrl: false,
    imageThreshold: 0,
  });

  const allRows = [];
  for (const page of imageResult.pages || []) {
    for (const image of page.images || []) {
      if (!image.data) {
        continue;
      }
      const ocrResult = await Tesseract.recognize(Buffer.from(image.data), 'eng');
      const rows = extractRowsFromText(ocrResult.data?.text || '');
      allRows.push(...rows);
    }
  }

  return allRows;
};

const isPdfFile = (mimeType, originalName) => {
  const byMime = typeof mimeType === 'string' && mimeType.toLowerCase().includes('pdf');
  const byExt = typeof originalName === 'string' && originalName.toLowerCase().endsWith('.pdf');
  return byMime || byExt;
};

const parseDocumentRows = async (filePath, mimeType, originalName) => {
  if (isPdfFile(mimeType, originalName)) {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const [tableData, textData, ocrRowsByScreenshot, ocrRowsByImage] = await Promise.all([
        parser.getTable().catch(() => null),
        parser
          .getText({
            pageJoiner: '',
            lineEnforce: true,
            cellSeparator: '\t',
          })
          .catch(() => null),
        ocrPdfPages(parser).catch(() => []),
        ocrPdfEmbeddedImages(parser).catch(() => []),
      ]);

      const tableRows = extractRowsFromTableResult(tableData);
      const textRows = extractRowsFromText(textData?.text || '');
      const ocrRows = mergeUniqueRows(ocrRowsByScreenshot, ocrRowsByImage);

      let fallbackTextRows = [];
      if (!textRows.length) {
        const defaultTextData = await parser.getText().catch(() => null);
        fallbackTextRows = extractRowsFromText(defaultTextData?.text || '');
      }

      const bestPrimaryRows = rowContentScore(ocrRows) >= rowContentScore(tableRows) ? ocrRows : tableRows;
      const mergedRows = mergeUniqueRows(bestPrimaryRows, textRows, fallbackTextRows, tableRows, ocrRows);

      if (rowContentScore(mergedRows) > 0) {
        return mergedRows;
      }

      return mergeUniqueRows(bestPrimaryRows, textRows, fallbackTextRows);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  try {
    const result = await Tesseract.recognize(filePath, 'eng');
    return extractRowsFromText(result.data?.text || '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OCR failed for non-PDF file: ${message}`);
  }
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/invoices/scan', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const uploadedFilePath = req.file.path;

  try {
    const rows = await parseDocumentRows(uploadedFilePath, req.file.mimetype, req.file.originalname);
    const hasReadableRows = rows.length > 0;
    const finalRows = hasReadableRows
      ? rows
      : [
          ['No readable invoice data found in this file.'],
          ['Try a clearer PDF/image or higher-resolution scan.'],
        ];

    const fileId = crypto.randomUUID();
    const fileName = `invoice_${Date.now()}.xlsx`;
    const excelPath = writeWorkbook(finalRows, fileName);
    const workbookBuffer = fs.readFileSync(excelPath);
    const xlsxBase64 = workbookBuffer.toString('base64');

    if (!process.env.VERCEL) {
      downloadRegistry.set(fileId, {
        path: excelPath,
        fileName,
        createdAt: Date.now(),
      });
    } else {
      fs.rmSync(excelPath, { force: true });
    }

    fs.rmSync(uploadedFilePath, { force: true });

    return res.json({
      fileId: process.env.VERCEL ? '' : fileId,
      fileName,
      xlsxBase64,
      rows: finalRows,
      warning: hasReadableRows
        ? null
        : 'OCR could not extract structured rows. A diagnostic Excel file was generated instead.',
    });
  } catch (error) {
    console.error('Invoice scan failed:', error);
    fs.rmSync(uploadedFilePath, { force: true });
    return res.status(500).json({
      error: `Processing failed: ${error.message}`,
    });
  }
});

app.get('/api/invoices/download/:fileId', (req, res) => {
  const entry = downloadRegistry.get(req.params.fileId);

  if (!entry || !fs.existsSync(entry.path)) {
    return res.status(404).json({ error: 'Excel file not found or expired.' });
  }

  return res.download(entry.path, entry.fileName);
});

if (!process.env.VERCEL) {
  setInterval(() => {
    const maxAgeMs = 30 * 60 * 1000;
    const now = Date.now();

    for (const [fileId, meta] of downloadRegistry.entries()) {
      if (now - meta.createdAt > maxAgeMs) {
        fs.rmSync(meta.path, { force: true });
        downloadRegistry.delete(fileId);
      }
    }
  }, 5 * 60 * 1000);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
