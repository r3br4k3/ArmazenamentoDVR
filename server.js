const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const jsQR = require("jsqr");
const QrCode = require("qrcode-reader");
const QRCode = require("qrcode");
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
const ADMIN_PASSWORD = "p3p3r0n1";
const ADMIN_PANEL_PASSWORD = "william200";

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

function normalizePhotoUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("/uploads/")) {
    return "";
  }

  const safeName = path.basename(normalized);
  const filePath = path.join(uploadsDir, safeName);
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return `/uploads/${safeName}`;
}

function readUsers() {
  const users = readJson("users.json");
  return Array.isArray(users) ? users : [];
}

function writeUsers(users) {
  writeJson("users.json", users);
}

function parseDeviceInfo(req) {
  const userAgent = String(req.get("user-agent") || "").trim();
  const chPlatform = String(req.get("sec-ch-ua-platform") || "")
    .replace(/"/g, "")
    .trim();
  const chModel = String(req.get("sec-ch-ua-model") || "")
    .replace(/"/g, "")
    .trim();
  const chMobile = String(req.get("sec-ch-ua-mobile") || "")
    .replace(/"/g, "")
    .trim();

  const lowerUa = userAgent.toLowerCase();
  const isMobile = chMobile === "?1" || /android|iphone|ipad|mobile/.test(lowerUa);
  const type = isMobile ? "celular" : "pc";

  let platform = chPlatform || "Desconhecido";
  if (platform === "Desconhecido") {
    if (/iphone|ipad|ios/.test(lowerUa)) platform = "iOS";
    else if (/android/.test(lowerUa)) platform = "Android";
    else if (/windows/.test(lowerUa)) platform = "Windows";
    else if (/mac os|macintosh/.test(lowerUa)) platform = "macOS";
    else if (/linux/.test(lowerUa)) platform = "Linux";
  }

  const browser = /edg\//i.test(userAgent)
    ? "Edge"
    : /chrome\//i.test(userAgent)
      ? "Chrome"
      : /firefox\//i.test(userAgent)
        ? "Firefox"
        : /safari\//i.test(userAgent) && !/chrome\//i.test(userAgent)
          ? "Safari"
          : "Navegador desconhecido";

  const model = chModel || (isMobile ? platform : `${platform} PC`);
  const label = `${type === "celular" ? "Celular" : "PC"} ${model} (${browser})`;

  return {
    type,
    platform,
    model,
    browser,
    label,
    rawUserAgent: userAgent,
  };
}

function ensureUser(deviceId, deviceInfo) {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) {
    return null;
  }

  const users = readUsers();
  const now = new Date().toISOString();
  const idx = users.findIndex((user) => String(user.deviceId || "").trim() === normalizedDeviceId);

  if (idx === -1) {
    const createdUser = {
      deviceId: normalizedDeviceId,
      deviceType: deviceInfo.type,
      devicePlatform: deviceInfo.platform,
      deviceModel: deviceInfo.model,
      deviceBrowser: deviceInfo.browser,
      deviceLabel: deviceInfo.label,
      rawUserAgent: deviceInfo.rawUserAgent,
      isBanned: false,
      createdAt: now,
      lastSeenAt: now,
    };
    users.push(createdUser);
    writeUsers(users);
    return createdUser;
  }

  const updatedUser = {
    ...users[idx],
    deviceType: deviceInfo.type,
    devicePlatform: deviceInfo.platform,
    deviceModel: deviceInfo.model,
    deviceBrowser: deviceInfo.browser,
    deviceLabel: deviceInfo.label,
    rawUserAgent: deviceInfo.rawUserAgent,
    lastSeenAt: now,
  };
  users[idx] = updatedUser;
  writeUsers(users);
  return updatedUser;
}

function getUserByDeviceId(deviceId) {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) {
    return null;
  }

  return readUsers().find((user) => String(user.deviceId || "").trim() === normalizedDeviceId) || null;
}

function assertUserNotBanned(deviceId) {
  const user = getUserByDeviceId(deviceId);
  if (user?.isBanned) {
    const error = new Error("Este usuario esta banido e nao pode alterar DVRs.");
    error.statusCode = 403;
    throw error;
  }
}

function getAdminPanelPassword(req) {
  return String(req.get("x-admin-password") || req.body?.adminPanelPassword || "").trim();
}

function requireAdminPanel(req, res) {
  if (getAdminPanelPassword(req) !== ADMIN_PANEL_PASSWORD) {
    res.status(403).json({ message: "Senha admin invalida." });
    return false;
  }

  return true;
}

function attachCreatorMetadata(records) {
  const usersByDeviceId = new Map(
    readUsers().map((user) => [String(user.deviceId || "").trim(), user])
  );

  return records.map((record) => {
    const creatorDeviceId = String(record.creatorDeviceId || "").trim();
    const owner = usersByDeviceId.get(creatorDeviceId);

    return {
      ...record,
      creatorDeviceId,
      creatorDeviceLabel: record.creatorDeviceLabel || owner?.deviceLabel || "",
      creatorDeviceModel: record.creatorDeviceModel || owner?.deviceModel || "",
      creatorDevicePlatform: record.creatorDevicePlatform || owner?.devicePlatform || "",
      creatorDeviceType: record.creatorDeviceType || owner?.deviceType || "",
    };
  });
}

function canManageRecord(record, deviceId, adminPassword) {
  const ownerId = String(record.creatorDeviceId || "").trim();
  if (!ownerId) {
    return true;
  }

  if (ownerId === deviceId) {
    return true;
  }

  return adminPassword === ADMIN_PASSWORD;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function createSerialQrCard(serial) {
  const normalizedSerial = String(serial || "").trim();
  const qrBuffer = await QRCode.toBuffer(normalizedSerial, {
    width: 540,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#0a2c63",
      light: "#ffffff",
    },
  });

  const qrMeta = await sharp(qrBuffer).metadata();
  const qrWidth = qrMeta.width || 540;
  const qrHeight = qrMeta.height || 540;
  const labelHeight = 110;

  const labelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${qrWidth}" height="${labelHeight}">
      <rect width="100%" height="100%" fill="#0f244a"/>
      <text x="50%" y="58%" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-size="34" font-weight="700" fill="#eaf3ff">${escapeXml(normalizedSerial)}</text>
    </svg>
  `);

  const cardBuffer = await sharp({
    create: {
      width: qrWidth,
      height: qrHeight + labelHeight,
      channels: 4,
      background: "#ffffff",
    },
  })
    .composite([
      { input: qrBuffer, top: 0, left: 0 },
      { input: labelSvg, top: qrHeight, left: 0 },
    ])
    .png()
    .toBuffer();

  const fileName = `serial-card-${Date.now()}-${uuidv4()}.png`;
  const filePath = path.join(uploadsDir, fileName);
  await fs.promises.writeFile(filePath, cardBuffer);
  return `/uploads/${fileName}`;
}

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
  res.json({ records: attachCreatorMetadata(sorted) });
});

app.get("/api/admin/overview", (req, res) => {
  if (!requireAdminPanel(req, res)) {
    return;
  }

  const users = readUsers().sort((a, b) => {
    const left = a.lastSeenAt || a.createdAt || "";
    const right = b.lastSeenAt || b.createdAt || "";
    return left < right ? 1 : -1;
  });
  const records = attachCreatorMetadata(readJson("records.json")).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ users, records });
});

app.post("/api/admin/users/:deviceId/ban", (req, res) => {
  if (!requireAdminPanel(req, res)) {
    return;
  }

  const targetDeviceId = String(req.params.deviceId || "").trim();
  const users = readUsers();
  const idx = users.findIndex((user) => String(user.deviceId || "").trim() === targetDeviceId);

  if (idx === -1) {
    res.status(404).json({ message: "Usuario nao encontrado." });
    return;
  }

  users[idx] = {
    ...users[idx],
    isBanned: true,
    bannedAt: new Date().toISOString(),
  };
  writeUsers(users);
  res.json({ user: users[idx] });
});

app.post("/api/admin/users/:deviceId/unban", (req, res) => {
  if (!requireAdminPanel(req, res)) {
    return;
  }

  const targetDeviceId = String(req.params.deviceId || "").trim();
  const users = readUsers();
  const idx = users.findIndex((user) => String(user.deviceId || "").trim() === targetDeviceId);

  if (idx === -1) {
    res.status(404).json({ message: "Usuario nao encontrado." });
    return;
  }

  users[idx] = {
    ...users[idx],
    isBanned: false,
    unbannedAt: new Date().toISOString(),
  };
  writeUsers(users);
  res.json({ user: users[idx] });
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

app.post("/api/serial-card", async (req, res) => {
  const serial = String(req.body?.serial || "").trim();
  if (!serial) {
    res.status(400).json({ message: "Informe o serial para gerar o QR" });
    return;
  }

  try {
    const imageUrl = await createSerialQrCard(serial);
    res.status(201).json({ serial, imageUrl });
  } catch (error) {
    console.error("[QR] Falha ao gerar imagem de card do serial:", error);
    res.status(500).json({ message: "Falha ao gerar imagem do QR" });
  }
});

app.post("/api/records", upload.single("photo"), async (req, res) => {
  const payload = req.body;
  let serial = String(payload.serial || "").trim();
  const dvrName = String(payload.dvrName || "").trim();
  const dvrLogin = String(payload.dvrLogin || "").trim() || "admin";
  const dvrPassword = String(payload.dvrPassword || "").trim() || "mactel3023";
  const deviceId = String(payload.deviceId || "").trim();
  const creatorDevice = ensureUser(deviceId, parseDeviceInfo(req));

  try {
    assertUserNotBanned(deviceId);
  } catch (error) {
    res.status(error.statusCode || 403).json({ message: error.message });
    return;
  }

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
    photoUrl: req.file ? `/uploads/${req.file.filename}` : normalizePhotoUrl(payload.qrCardImageUrl),
    creatorDeviceId: deviceId,
    creatorDeviceLabel: creatorDevice?.deviceLabel || "",
    creatorDeviceModel: creatorDevice?.deviceModel || "",
    creatorDevicePlatform: creatorDevice?.devicePlatform || "",
    creatorDeviceType: creatorDevice?.deviceType || "",
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
  const deviceId = String(payload.deviceId || "").trim();
  const adminPassword = String(payload.adminPassword || "").trim();
  const currentDevice = ensureUser(deviceId, parseDeviceInfo(req));

  try {
    assertUserNotBanned(deviceId);
  } catch (error) {
    res.status(error.statusCode || 403).json({ message: error.message });
    return;
  }

  if (!canManageRecord(current, deviceId, adminPassword)) {
    res.status(403).json({
      message: "Voce nao tem autorizacao para excluir este DVR.",
      requiresPassword: true,
    });
    return;
  }

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
  } else {
    const qrCardPhotoUrl = normalizePhotoUrl(payload.qrCardImageUrl);
    if (qrCardPhotoUrl) {
      photoUrl = qrCardPhotoUrl;
    }
  }

  const updatedRecord = {
    ...current,
    dvrName,
    serial,
    dvrLogin,
    dvrPassword,
    photoUrl,
    creatorDeviceId: current.creatorDeviceId || deviceId,
    creatorDeviceLabel: current.creatorDeviceLabel || currentDevice?.deviceLabel || "",
    creatorDeviceModel: current.creatorDeviceModel || currentDevice?.deviceModel || "",
    creatorDevicePlatform: current.creatorDevicePlatform || currentDevice?.devicePlatform || "",
    creatorDeviceType: current.creatorDeviceType || currentDevice?.deviceType || "",
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

  const current = records[idx];
  const deviceId = String(req.body?.deviceId || "").trim();
  const adminPassword = String(req.body?.adminPassword || "").trim();

  ensureUser(deviceId, parseDeviceInfo(req));

  try {
    assertUserNotBanned(deviceId);
  } catch (error) {
    res.status(error.statusCode || 403).json({ message: error.message });
    return;
  }

  if (!canManageRecord(current, deviceId, adminPassword)) {
    res.status(403).json({
      message: "voce nao e o usuario que criou este dvr",
      requiresPassword: true,
    });
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
