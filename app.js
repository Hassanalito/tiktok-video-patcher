const input = document.querySelector('#fileInput');
const drop = document.querySelector('#dropZone');
const patchButton = document.querySelector('#patchButton');
const downloadButton = document.querySelector('#downloadButton');
const filePanel = document.querySelector('#filePanel');
const status = document.querySelector('#status');
let selectedFile = null;
let resultUrl = null;

const u32 = (view, offset) => view.getUint32(offset, false);
const writeU32 = (view, offset, value) => view.setUint32(offset, value >>> 0, false);
const typeAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

function parseBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = u32(view, offset);
    const type = typeAt(bytes, offset);
    let header = 8;
    if (size === 1) {
      const high = u32(view, offset + 8);
      const low = u32(view, offset + 12);
      if (high !== 0) throw new Error('الملف كبير جدًا لهذه النسخة.');
      size = low;
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) break;
    boxes.push({ type, offset, size, header });
    offset += size;
  }
  return boxes;
}

function patchChunkOffsets(moovBytes, delta) {
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta']);
  function walk(start, end) {
    for (const box of parseBoxes(moovBytes, start, end)) {
      const body = box.offset + box.header;
      if (box.type === 'stco') {
        const count = u32(view, body + 4);
        for (let i = 0; i < count; i++) {
          const at = body + 8 + i * 4;
          const next = u32(view, at) + delta;
          if (next < 0 || next > 0xffffffff) throw new Error('مواقع بيانات الفيديو خارج النطاق المدعوم.');
          writeU32(view, at, next);
        }
      } else if (box.type === 'co64') {
        const count = u32(view, body + 4);
        for (let i = 0; i < count; i++) {
          const at = body + 8 + i * 8;
          const oldHigh = u32(view, at), oldLow = u32(view, at + 4);
          const value = oldHigh * 4294967296 + oldLow + delta;
          writeU32(view, at, Math.floor(value / 4294967296));
          writeU32(view, at + 4, value % 4294967296);
        }
      } else if (containers.has(box.type)) {
        walk(body + (box.type === 'meta' ? 4 : 0), box.offset + box.size);
      }
    }
  }
  walk(0, moovBytes.length);
}

async function optimizeMp4(file) {
  const headSize = Math.min(file.size, 4 * 1024 * 1024);
  let bytes = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  let boxes = parseBoxes(bytes);
  let moov = boxes.find(box => box.type === 'moov');
  let mdat = boxes.find(box => box.type === 'mdat');

  if (!moov || !mdat) {
    bytes = new Uint8Array(await file.arrayBuffer());
    boxes = parseBoxes(bytes);
    moov = boxes.find(box => box.type === 'moov');
    mdat = boxes.find(box => box.type === 'mdat');
  }
  if (!moov || !mdat) throw new Error('لم أجد بنية MP4 صالحة داخل الملف.');

  const moovBytes = new Uint8Array(await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer());
  const ftyp = boxes.find(box => box.type === 'ftyp');
  const ftypBlob = ftyp ? file.slice(ftyp.offset, ftyp.offset + ftyp.size) : new Blob([]);
  const newMdatOffset = ftypBlob.size + moovBytes.length;
  const delta = newMdatOffset - mdat.offset;
  patchChunkOffsets(moovBytes, delta);

  // Keep the encoded media payload byte-for-byte; remove padding and relocate metadata first.
  const ordered = [ftypBlob, moovBytes, file.slice(mdat.offset, mdat.offset + mdat.size)];
  for (const box of boxes) {
    if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(box.type)) {
      ordered.push(file.slice(box.offset, box.offset + box.size));
    }
  }
  return new Blob(ordered, { type: 'video/mp4' });
}

function prettyBytes(bytes) {
  const units = ['بايت', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function setFile(file) {
  if (!file) return;
  if (!/\.mp4$/i.test(file.name) && file.type !== 'video/mp4') {
    showMessage('اختر ملف MP4 فقط.', true); return;
  }
  clearResult();
  selectedFile = file;
  document.querySelector('#fileName').textContent = file.name;
  document.querySelector('#fileDetails').textContent = `${prettyBytes(file.size)} · MP4`;
  filePanel.hidden = false;
  drop.hidden = true;
  patchButton.disabled = false;
  showMessage('جاهز للمعالجة. لن يتم رفع الملف لأي مكان.');
}

function showMessage(text, error = false) {
  const message = document.querySelector('#message');
  message.textContent = text;
  message.style.color = error ? '#ff7b91' : '';
}

function updateProgress(value, text) {
  status.hidden = false;
  document.querySelector('#progressBar').style.width = `${value}%`;
  document.querySelector('#statusPercent').textContent = `${value}%`;
  document.querySelector('#statusText').textContent = text;
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  downloadButton.hidden = true;
  status.hidden = true;
}

function reset() {
  selectedFile = null; input.value = ''; clearResult();
  filePanel.hidden = true; drop.hidden = false; patchButton.disabled = true;
  showMessage('الفيديو لا يغادر جهازك نهائيًا.');
}

drop.addEventListener('click', () => input.click());
input.addEventListener('change', () => setFile(input.files[0]));
document.querySelector('#removeFile').addEventListener('click', reset);
for (const event of ['dragenter', 'dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

patchButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  patchButton.disabled = true;
  clearResult();
  try {
    updateProgress(18, 'قراءة بنية MP4…');
    await new Promise(requestAnimationFrame);
    updateProgress(48, 'تحديث جداول العينات…');
    const output = await optimizeMp4(selectedFile);
    updateProgress(82, 'تجهيز ملف التحميل…');
    resultUrl = URL.createObjectURL(output);
    const cleanName = selectedFile.name.replace(/\.mp4$/i, '');
    downloadButton.href = resultUrl;
    downloadButton.download = `${cleanName}_patched.mp4`;
    downloadButton.hidden = false;
    updateProgress(100, 'اكتملت المعالجة بدون إعادة ترميز');
    showMessage(`تم تجهيز الملف · ${prettyBytes(output.size)}`);
  } catch (error) {
    status.hidden = true;
    showMessage(error.message || 'تعذرت معالجة هذا الملف.', true);
  } finally {
    patchButton.disabled = false;
  }
});
