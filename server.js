const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const jsQR = require("jsqr");
const QrCode = require("qrcode-reader");
const sharp = require("sharp");
const {
  MultiFormatReader,
  BinaryBitmap,
  HybridBinarizer,
  RGBLuminanceSource,
  DecodeHintType,
  BarcodeFormat,
} = require("@zxing/library");
const { Jimp } = require("jimp");
const { v4: uuidv4 } = require("uuid");
const { readJson, writeJson } = require("./lib/store");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${uuidv4()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Somente imagens sao permitidas"));
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

function decodeQrFromBitmap(bitmap) {
  if (!bitmap || !bitmap.data || !bitmap.width || !bitmap.height) {
    return "";
  }

  const pixels = new Uint8ClampedArray(bitmap.data);
  const result = jsQR(pixels, bitmap.width, bitmap.height, {
    inversionAttempts: "attemptBoth",
  });
  if (result?.data) {
    return String(result.data).trim();
  }

  return "";
}

async function decodeQrWithQrCodeReader(bitmap) {
  if (!bitmap || !bitmap.data || !bitmap.width || !bitmap.height) {
    return "";
  }

  return new Promise((resolve) => {
    const qr = new QrCode();
    qr.callback = (error, value) => {
      if (error || !value?.result) {
        resolve("");
        return;
      }

      resolve(String(value.result).trim());
    };

    try {
      qr.decode(bitmap);
    } catch {
      resolve("");
    }
  });
}

function decodeWithZxing(bitmap) {
  if (!bitmap || !bitmap.data || !bitmap.width || !bitmap.height) {
    return "";
  }

  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.DATA_MATRIX,
    BarcodeFormat.AZTEC,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.ITF,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
  ]);

  reader.setHints(hints);

  try {
    const luminanceSource = new RGBLuminanceSource(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height);
    const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
    const result = reader.decode(binaryBitmap);
    return result?.getText ? String(result.getText()).trim() : "";
  } catch {
    return "";
  } finally {
    reader.reset();
  }
}

async function decodeQrRemoteFromBuffer(imageBuffer, fileName) {
  if (typeof fetch !== "function" || typeof FormData === "undefined" || typeof Blob === "undefined") {
    return "";
  }

  const form = new FormData();
  form.append("file", new Blob([imageBuffer]), fileName);

  const response = await fetch("https://api.qrserver.com/v1/read-qr-code/", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    return "";
  }

  const payload = await response.json().catch(() => []);
  const data = payload?.[0]?.symbol?.[0]?.data;
  return typeof data === "string" ? data.trim() : "";
}

function buildScanRegions(image) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  const centerBottomSize = Math.floor(Math.min(width * 0.66, height * 0.45));
  const centerBottomX = Math.max(0, Math.floor((width - centerBottomSize) / 2));
  const centerBottomY = Math.max(0, Math.floor(height * 0.48));
  const centerBottomH = Math.min(centerBottomSize, height - centerBottomY);

  // Para screenshots de celular onde o QR fica na parte inferior
  const qrSize = Math.floor(Math.min(width * 0.75, height * 0.38));
  const qrX = Math.max(0, Math.floor((width - qrSize) / 2));

  return [
    { name: "full",          x: 0,    y: 0,                           w: width,  h: height },
    { name: "bottom-70",     x: 0,    y: Math.floor(height * 0.30),   w: width,  h: Math.floor(height * 0.70) },
    { name: "bottom-65",     x: 0,    y: Math.floor(height * 0.35),   w: width,  h: Math.floor(height * 0.65) },
    { name: "bottom-50",     x: 0,    y: Math.floor(height * 0.50),   w: width,  h: Math.floor(height * 0.50) },
    { name: "bottom-40",     x: 0,    y: Math.floor(height * 0.60),   w: width,  h: Math.floor(height * 0.40) },
    { name: "bottom-30",     x: 0,    y: Math.floor(height * 0.70),   w: width,  h: Math.floor(height * 0.30) },
    {
      name: "center-bottom",
      x: centerBottomX,
      y: centerBottomY,
      w: centerBottomSize,
      h: centerBottomH,
    },
    {
      name: "qr-zone",
      x: qrX,
      y: Math.max(0, Math.floor(height * 0.55)),
      w: qrSize,
      h: Math.min(qrSize, height - Math.floor(height * 0.55)),
    },
  ];
}

async function extractQrDataLocal(image) {
  console.log(`[QR] Iniciando scan local. Dimensoes: ${image.bitmap.width}x${image.bitmap.height}`);
  const candidates = [0, 90, 180, 270];
  const scales = [1, 1.5, 2, 3];

  for (const angle of candidates) {
    const rotated = angle === 0 ? image.clone() : image.clone().rotate(angle, false);
    const regions = buildScanRegions(rotated);

    for (const region of regions) {
      const base = rotated.clone().crop({ x: region.x, y: region.y, w: region.w, h: region.h });
      console.log(`[QR] Tentando regiao=${region.name} angle=${angle} crop=${base.bitmap.width}x${base.bitmap.height}`);
      const variants = [base.clone(), base.clone().greyscale().contrast(0.5)];

      for (const variant of variants) {
        for (const scale of scales) {
          const scaled =
            scale === 1
              ? variant.clone()
              : variant.clone().resize({
                  w: Math.max(64, Math.floor(variant.bitmap.width * scale)),
                  h: Math.max(64, Math.floor(variant.bitmap.height * scale)),
                });

          const decodedByJsQr = decodeQrFromBitmap(scaled.bitmap);
          if (decodedByJsQr) {
            console.log(`[QR] jsQR encontrou serial na regiao=${region.name} scale=${scale}`);
            return decodedByJsQr;
          }

          const decodedByQrReader = await decodeQrWithQrCodeReader(scaled.bitmap);
          if (decodedByQrReader) {
            console.log(`[QR] qrcode-reader encontrou serial na regiao=${region.name} scale=${scale}`);
            return decodedByQrReader;
          }

          const decodedByZxing = decodeWithZxing(scaled.bitmap);
          if (decodedByZxing) {
            console.log(`[QR] ZXing encontrou serial na regiao=${region.name} scale=${scale}`);
            return decodedByZxing;
          }
        }
      }
    }
  }

  console.log("[QR] Scan local nao encontrou QR. Tentando API remota...");
  return "";
}

async function loadImageWithSharp(filePath) {
  const sharpImg = sharp(filePath).rotate(); // rotate() auto-corrige orientação EXIF
  const { width, height } = await sharpImg.metadata().then(async (m) => {
    if (m.width && m.height) return m;
    const meta = await sharp(filePath).metadata();
    return meta;
  });

  const rawBuffer = await sharpImg
    .ensureAlpha()
    .raw()
    .toBuffer();

  return {
    bitmap: {
      data: rawBuffer,
      width,
      height,
    },
    // wrapper mínimo compatível com buildScanRegions
    _sharpRaw: { width, height, rawBuffer },
  };
}

async function extractQrDataFromFile(filePath) {
  console.log(`[QR] Carregando imagem via sharp: ${filePath}`);

  // --- Caminho principal: sharp (suporta WebP, JPEG, PNG, HEIC, etc.) ---
  let sharpImage;
  try {
    sharpImage = await loadImageWithSharp(filePath);
    console.log(`[QR] Imagem carregada: ${sharpImage.bitmap.width}x${sharpImage.bitmap.height}`);
  } catch (sharpErr) {
    console.error("[QR] sharp falhou, tentando Jimp:", sharpErr.message);
  }

  if (sharpImage) {
    const { width, height, rawBuffer } = sharpImage._sharpRaw;

    // Tentar ler QR direto na imagem completa
    const fullBitmap = { data: rawBuffer, width, height };
    const directJsqr = decodeQrFromBitmap(fullBitmap);
    if (directJsqr) {
      console.log(`[QR] jsQR leu serial direto: ${directJsqr}`);
      return directJsqr;
    }
    const directZxing = decodeWithZxing(fullBitmap);
    if (directZxing) {
      console.log(`[QR] ZXing leu serial direto: ${directZxing}`);
      return directZxing;
    }

    // Tentar regiões de corte + escalas via sharp
    const regions = [
      { name: "full",       x: 0,                          y: 0,                          w: width,              h: height },
      { name: "bottom-70",  x: 0,                          y: Math.floor(height * 0.30),  w: width,              h: Math.floor(height * 0.70) },
      { name: "bottom-50",  x: 0,                          y: Math.floor(height * 0.50),  w: width,              h: Math.floor(height * 0.50) },
      { name: "bottom-40",  x: 0,                          y: Math.floor(height * 0.60),  w: width,              h: Math.floor(height * 0.40) },
      { name: "bottom-30",  x: 0,                          y: Math.floor(height * 0.70),  w: width,              h: Math.floor(height * 0.30) },
      {
        name: "qr-zone",
        x: Math.floor(width * 0.10),
        y: Math.floor(height * 0.55),
        w: Math.floor(width * 0.80),
        h: Math.min(Math.floor(width * 0.80), Math.floor(height * 0.45)),
      },
    ];

    for (const region of regions) {
      const rw = Math.max(1, Math.min(region.w, width - region.x));
      const rh = Math.max(1, Math.min(region.h, height - region.y));

      for (const scale of [1, 2, 3]) {
        const targetW = Math.floor(rw * scale);
        const targetH = Math.floor(rh * scale);

        try {
          const cropBuf = await sharp(filePath)
            .rotate()
            .extract({ left: region.x, top: region.y, width: rw, height: rh })
            .resize(targetW, targetH, { kernel: sharp.kernel.lanczos3 })
            .ensureAlpha()
            .raw()
            .toBuffer();

          const cropBitmap = { data: cropBuf, width: targetW, height: targetH };

          const r1 = decodeQrFromBitmap(cropBitmap);
          if (r1) { console.log(`[QR] jsQR: regiao=${region.name} scale=${scale}`); return r1; }

          const r2 = await decodeQrWithQrCodeReader(cropBitmap);
          if (r2) { console.log(`[QR] qrcode-reader: regiao=${region.name} scale=${scale}`); return r2; }

          const r3 = decodeWithZxing(cropBitmap);
          if (r3) { console.log(`[QR] ZXing: regiao=${region.name} scale=${scale}`); return r3; }

          // Tentar também versão em escala de cinza com alto contraste
          const grayBuf = await sharp(filePath)
            .rotate()
            .extract({ left: region.x, top: region.y, width: rw, height: rh })
            .resize(targetW, targetH, { kernel: sharp.kernel.lanczos3 })
            .greyscale()
            .normalise()
            .ensureAlpha()
            .raw()
            .toBuffer();

          const grayBitmap = { data: grayBuf, width: targetW, height: targetH };

          const r4 = decodeQrFromBitmap(grayBitmap);
          if (r4) { console.log(`[QR] jsQR (gray): regiao=${region.name} scale=${scale}`); return r4; }

          const r5 = decodeWithZxing(grayBitmap);
          if (r5) { console.log(`[QR] ZXing (gray): regiao=${region.name} scale=${scale}`); return r5; }

        } catch (cropErr) {
          console.warn(`[QR] Erro ao processar regiao=${region.name} scale=${scale}:`, cropErr.message);
        }
      }
    }

    // Fallback remoto com sharp
    console.log("[QR] Tentando API remota com sharp...");
    for (const region of regions) {
      const rw = Math.max(1, Math.min(region.w, width - region.x));
      const rh = Math.max(1, Math.min(region.h, height - region.y));
      try {
        const pngBuf = await sharp(filePath)
          .rotate()
          .extract({ left: region.x, top: region.y, width: rw, height: rh })
          .png()
          .toBuffer();
        const remote = await decodeQrRemoteFromBuffer(pngBuf, `${region.name}.png`).catch(() => "");
        if (remote) { console.log(`[QR] API remota: regiao=${region.name}`); return remote; }
      } catch {}
    }
  }

  // --- Caminho de fallback: Jimp (não suporta WebP, mas cobre outros formatos) ---
  console.log("[QR] Tentando fallback com Jimp...");
  try {
    const image = await Jimp.read(filePath);
    const local = await extractQrDataLocal(image).catch(() => "");
    if (local) return local;

    const regions2 = buildScanRegions(image);
    for (const region of regions2) {
      const candidate = image.clone().crop({ x: region.x, y: region.y, w: region.w, h: region.h });
      const candidateBuffer = await candidate.getBuffer("image/png");
      const remote = await decodeQrRemoteFromBuffer(candidateBuffer, `${region.name}.png`).catch(() => "");
      if (remote) return remote;
    }

    const fullBuffer = await image.getBuffer("image/png");
    return await decodeQrRemoteFromBuffer(fullBuffer, path.basename(filePath)).catch(() => "");
  } catch (jimpErr) {
    console.error("[QR] Jimp também falhou:", jimpErr.message);
    return "";
  }
}

app.get("/api/records", (_req, res) => {
  const records = readJson("records.json");
  const sorted = records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ records: sorted });
});

app.post("/api/scan-serial", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "Envie uma foto para leitura de QR" });
    return;
  }

  try {
    console.log(`[QR] Arquivo recebido: ${req.file.originalname} (${req.file.size} bytes)`);
    const serial = await extractQrDataFromFile(req.file.path);

    fs.unlink(req.file.path, () => {});

    if (!serial) {
      console.log("[QR] Nenhum serial encontrado na imagem.");
      res.status(422).json({ message: "QR nao encontrado na imagem" });
      return;
    }

    console.log(`[QR] Serial encontrado: ${serial}`);
    res.json({ serial });
  } catch (err) {
    console.error("[QR] Erro no processamento:", err);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ message: "Falha ao ler QR da imagem" });
  }
});

app.post("/api/records", upload.single("photo"), async (req, res) => {
  const payload = req.body;
  let serial = String(payload.serial || "").trim();
  const dvrName = String(payload.dvrName || "").trim();
  const dvrLogin = String(payload.dvrLogin || "").trim() || "admin";
  const dvrPassword = String(payload.dvrPassword || "").trim() || "mactel3023";

  if (!serial && req.file) {
    try {
      serial = await extractQrDataFromFile(req.file.path);
    } catch {
      serial = "";
    }
  }

  if (!serial || !dvrName) {
    res.status(400).json({ message: "Preencha nome e serial do DVR" });
    return;
  }

  const record = {
    id: uuidv4(),
    dvrName,
    serial,
    dvrLogin,
    dvrPassword,
    photoUrl: req.file ? `/uploads/${req.file.filename}` : "",
    createdAt: new Date().toISOString(),
  };

  const records = readJson("records.json");
  records.push(record);
  writeJson("records.json", records);

  res.status(201).json({ record });
});

app.put("/api/records/:id", upload.single("photo"), async (req, res) => {
  const records = readJson("records.json");
  const idx = records.findIndex((r) => r.id === req.params.id);

  if (idx === -1) {
    res.status(404).json({ message: "Registro nao encontrado" });
    return;
  }

  const current = records[idx];
  const payload = req.body;
  let serial = String(payload.serial || "").trim() || String(current.serial || "").trim();
  const dvrName = String(payload.dvrName || "").trim();
  const dvrLogin = String(payload.dvrLogin || "").trim() || "admin";
  const dvrPassword = String(payload.dvrPassword || "").trim() || "mactel3023";

  if (!serial && req.file) {
    try {
      const scanned = await extractQrDataFromFile(req.file.path);
      if (scanned) {
        serial = scanned;
      }
    } catch {}
  }

  if (!serial || !dvrName) {
    if (req.file) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(400).json({ message: "Preencha nome e serial do DVR" });
    return;
  }

  let photoUrl = current.photoUrl || "";
  if (req.file) {
    photoUrl = `/uploads/${req.file.filename}`;

    if (current.photoUrl) {
      const oldPhotoPath = path.join(__dirname, current.photoUrl.replace(/^\//, ""));
      if (fs.existsSync(oldPhotoPath)) {
        fs.unlink(oldPhotoPath, () => {});
      }
    }
  }

  const updatedRecord = {
    ...current,
    dvrName,
    serial,
    dvrLogin,
    dvrPassword,
    photoUrl,
    updatedAt: new Date().toISOString(),
  };

  records[idx] = updatedRecord;
  writeJson("records.json", records);

  res.json({ record: updatedRecord });
});

app.delete("/api/records/:id", (req, res) => {
  const records = readJson("records.json");
  const idx = records.findIndex((r) => r.id === req.params.id);

  if (idx === -1) {
    res.status(404).json({ message: "Registro nao encontrado" });
    return;
  }

  const [removed] = records.splice(idx, 1);
  writeJson("records.json", records);

  if (removed.photoUrl) {
    const photoPath = path.join(__dirname, removed.photoUrl.replace(/^\//, ""));
    if (fs.existsSync(photoPath)) {
      fs.unlink(photoPath, () => {});
    }
  }

  res.json({ ok: true });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ message: "Falha no upload da imagem" });
    return;
  }

  if (err) {
    res.status(400).json({ message: err.message || "Erro interno" });
    return;
  }

  res.status(500).json({ message: "Erro interno" });
});

app.listen(PORT, () => {
  console.log(`Servidor ativo em http://localhost:${PORT}`);
});
