const feedback = document.getElementById("feedback");
const recordsList = document.getElementById("recordsList");
const searchInput = document.getElementById("searchInput");
const installAppBtn = document.getElementById("installAppBtn");
const modal = document.getElementById("modal");
const scannerModal = document.getElementById("scannerModal");
const imageModal = document.getElementById("imageModal");
const deleteConfirmModal = document.getElementById("deleteConfirmModal");
const imageModalPreview = document.getElementById("imageModalPreview");
const closeImageModalBtn = document.getElementById("closeImageModalBtn");
const closeDeleteConfirmBtn = document.getElementById("closeDeleteConfirmBtn");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
const deleteConfirmText = document.getElementById("deleteConfirmText");
const deletePasswordWrap = document.getElementById("deletePasswordWrap");
const deletePasswordInput = document.getElementById("deletePasswordInput");
const deleteConfirmError = document.getElementById("deleteConfirmError");
const addBtn = document.getElementById("addBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const closeScannerBtn = document.getElementById("closeScannerBtn");
const modalTitle = document.getElementById("modalTitle");
const saveRecordBtn = document.getElementById("saveRecordBtn");
const scanQrBtn = document.getElementById("scanQrBtn");
const recordForm = document.getElementById("recordForm");
const photoInput = document.getElementById("photoInput");
const photoFileName = document.getElementById("photoFileName");
const scannerStatus = document.getElementById("scannerStatus");
const scannerVideo = document.getElementById("scannerVideo");
const serialInput = document.getElementById("serialInput");
const DEVICE_ID_STORAGE_KEY = "mactelDeviceId";

let allRecords = [];
let editingRecordId = "";
let scannerStream = null;
let scannerAnimationId = 0;
let barcodeDetector = null;
let deferredInstallPrompt = null;
const overlayStack = [];
let generatedQrCardUrl = "";
let pendingDeleteRecordId = "";
let editAdminPassword = "";
const deviceId = getOrCreateDeviceId();

function createDeviceId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateDeviceId() {
  const current = String(localStorage.getItem(DEVICE_ID_STORAGE_KEY) || "").trim();
  if (current) {
    return current;
  }

  const created = createDeviceId();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
  return created;
}

function pushOverlayState(type) {
  overlayStack.push(type);
  history.pushState({ overlay: type }, "");
}

function hideModalInternal() {
  modal.hidden = true;
  recordForm.reset();
  photoFileName.textContent = "Nenhum arquivo selecionado";
  generatedQrCardUrl = "";
  editAdminPassword = "";
  editingRecordId = "";
  setModalMode(false);
}

async function generateQrCardForSerial(serial) {
  const normalized = String(serial || "").trim();
  if (!normalized) {
    return;
  }

  try {
    const result = await api("/api/serial-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: normalized }),
    });

    if (!result.imageUrl) {
      return;
    }

    generatedQrCardUrl = result.imageUrl;
    photoFileName.textContent = "Imagem do DVR gerada pelo serial lido";
  } catch {
    setFeedback("Serial lido, mas falhou ao gerar a imagem do QR.", true);
  }
}

function hideScannerInternal() {
  scannerModal.hidden = true;
  stopScanner();
}

function hideImageInternal() {
  imageModal.hidden = true;
  imageModalPreview.src = "";
}

function hideDeleteConfirmInternal() {
  deleteConfirmModal.hidden = true;
  pendingDeleteRecordId = "";
  deletePasswordWrap.hidden = true;
  deletePasswordInput.value = "";
  deleteConfirmError.textContent = "";
  confirmDeleteBtn.disabled = false;
}

function closeTopOverlayFromHistory() {
  const top = overlayStack.pop();
  if (top === "scanner") {
    hideScannerInternal();
    return true;
  }

  if (top === "image") {
    hideImageInternal();
    return true;
  }

  if (top === "deleteConfirm") {
    hideDeleteConfirmInternal();
    return true;
  }

  if (top === "modal") {
    hideModalInternal();
    return true;
  }

  return false;
}

function closeOverlay(type) {
  const top = overlayStack[overlayStack.length - 1];
  if (top === type) {
    history.back();
    return;
  }

  if (type === "scanner") {
    hideScannerInternal();
    return;
  }

  if (type === "image") {
    hideImageInternal();
    return;
  }

  if (type === "deleteConfirm") {
    hideDeleteConfirmInternal();
    return;
  }

  if (type === "modal") {
    hideModalInternal();
  }
}

function setFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", isError);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Erro inesperado");
    error.payload = data;
    throw error;
  }

  return data;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // Sem bloqueio funcional se o service worker falhar.
  }
}

function openModal() {
  modal.hidden = false;
  pushOverlayState("modal");
}

function setModalMode(isEditing) {
  if (isEditing) {
    modalTitle.textContent = "Editar DVR";
    saveRecordBtn.textContent = "Salvar alteracoes";
    return;
  }

  modalTitle.textContent = "Novo DVR";
  saveRecordBtn.textContent = "Salvar DVR";
}

function closeModal() {
  closeOverlay("modal");
}

function stopScanner() {
  if (scannerAnimationId) {
    cancelAnimationFrame(scannerAnimationId);
    scannerAnimationId = 0;
  }

  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }

  scannerVideo.srcObject = null;
}

function closeScannerModal() {
  closeOverlay("scanner");
}

async function scanFrame() {
  if (!barcodeDetector || scannerModal.hidden || !scannerVideo.videoWidth) {
    scannerAnimationId = requestAnimationFrame(scanFrame);
    return;
  }

  try {
    const codes = await barcodeDetector.detect(scannerVideo);
    if (codes.length) {
      const rawValue = String(codes[0].rawValue || "").trim();
      if (rawValue) {
        serialInput.value = rawValue;
        scannerStatus.textContent = "QR lido com sucesso.";
        setFeedback("Serial lido automaticamente pela camera.");
        await generateQrCardForSerial(rawValue);
        closeScannerModal();
        return;
      }
    }
  } catch {
    scannerStatus.textContent = "Nao foi possivel ler o QR agora. Continue apontando a camera.";
  }

  scannerAnimationId = requestAnimationFrame(scanFrame);
}

async function openScannerModal() {
  if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
    setFeedback("Seu navegador nao permite abrir a camera. Use a imagem do DVR.", true);
    return;
  }

  if (!("BarcodeDetector" in window)) {
    setFeedback("Leitura por camera nao suportada neste navegador. Use a imagem do DVR.", true);
    return;
  }

  try {
    if (!barcodeDetector) {
      barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
    }

    scannerStatus.textContent = "Aponte a camera para o QR do DVR.";
    scannerModal.hidden = false;
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });

    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();
    pushOverlayState("scanner");
    scannerAnimationId = requestAnimationFrame(scanFrame);
  } catch (error) {
    hideScannerInternal();
    setFeedback(`Nao foi possivel abrir a camera: ${error.message || "erro inesperado"}`, true);
  }
}

function openImageModal(src, altText = "Imagem ampliada do DVR") {
  imageModalPreview.src = src;
  imageModalPreview.alt = altText;
  imageModal.hidden = false;
  pushOverlayState("image");
}

function closeImageModal() {
  closeOverlay("image");
}

function closeDeleteConfirmModal() {
  closeOverlay("deleteConfirm");
}

async function deleteRecordWithGuard(id, password = "") {
  const response = await fetch(`/api/records/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adminPassword: password, deviceId }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "Erro inesperado");
    error.payload = data;
    throw error;
  }

  return data;
}

function openDeleteConfirmModal(record) {
  pendingDeleteRecordId = record.id;
  deleteConfirmText.textContent = "Voce tem certeza que deseja excluir os dados deste DVR?";
  deleteConfirmError.textContent = "";
  deletePasswordInput.value = "";
  deletePasswordWrap.hidden = true;
  deleteConfirmModal.hidden = false;
  pushOverlayState("deleteConfirm");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cardLine(label, value) {
  if (!value) return "";
  return `<div><strong>${label}:</strong> ${escapeHtml(value)}</div>`;
}

function drawRecords(target, records, emptyMessage = "Nenhum DVR salvo ainda.") {
  if (!records.length) {
    target.innerHTML = `<p>${emptyMessage}</p>`;
    return;
  }

  target.innerHTML = records
    .map(
      (r) => `
      <article class="record">
        <div class="record-top">
          <h3>${escapeHtml(r.dvrName || "DVR sem nome")}</h3>
          <div class="record-actions">
            <button class="edit" data-id="${r.id}">Editar</button>
            <button class="delete" data-id="${r.id}">Excluir</button>
          </div>
        </div>
        ${r.photoUrl ? `<img class="clickable-photo" src="${r.photoUrl}" alt="Foto do DVR" />` : ""}
        <div class="meta">
          ${cardLine("Nome", r.dvrName)}
          ${cardLine("Serial", r.serial)}
          ${cardLine("Login", r.dvrLogin)}
          ${cardLine("Senha", r.dvrPassword)}
        </div>
      </article>
    `
    )
    .join("");
}

function applySearch() {
  const term = String(searchInput.value || "").trim().toLowerCase();
  const filtered = allRecords.filter((record) => {
    const haystack = `${record.dvrName || ""} ${record.serial || ""} ${record.dvrLogin || ""} ${record.dvrPassword || ""}`.toLowerCase();
    return haystack.includes(term);
  });

  filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  drawRecords(recordsList, filtered, "Nenhum DVR encontrado na pesquisa.");
}

async function loadRecords() {
  const { records } = await api("/api/records");
  allRecords = records;
  applySearch();
}

addBtn.addEventListener("click", () => {
  setFeedback("");
  editAdminPassword = "";
  editingRecordId = "";
  setModalMode(false);
  openModal();
});

closeModalBtn.addEventListener("click", closeModal);
closeImageModalBtn.addEventListener("click", closeImageModal);
closeDeleteConfirmBtn.addEventListener("click", closeDeleteConfirmModal);
cancelDeleteBtn.addEventListener("click", closeDeleteConfirmModal);
closeScannerBtn.addEventListener("click", closeScannerModal);
scanQrBtn.addEventListener("click", openScannerModal);
installAppBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  installAppBtn.hidden = true;

  if (choice?.outcome === "accepted") {
    setFeedback("Aplicativo instalado com sucesso.");
  }
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closeModal();
  }
});

scannerModal.addEventListener("click", (event) => {
  if (event.target === scannerModal) {
    closeScannerModal();
  }
});

imageModal.addEventListener("click", (event) => {
  if (event.target === imageModal) {
    closeImageModal();
  }
});

deleteConfirmModal.addEventListener("click", (event) => {
  if (event.target === deleteConfirmModal) {
    closeDeleteConfirmModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && overlayStack.length > 0) {
    history.back();
    return;
  }
});

window.addEventListener("popstate", () => {
  if (overlayStack.length > 0) {
    closeTopOverlayFromHistory();
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installAppBtn.hidden = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installAppBtn.hidden = true;
  setFeedback("Aplicativo instalado com sucesso.");
});

searchInput.addEventListener("input", applySearch);

confirmDeleteBtn.addEventListener("click", async () => {
  if (!pendingDeleteRecordId) {
    closeDeleteConfirmModal();
    return;
  }

  confirmDeleteBtn.disabled = true;
  deleteConfirmError.textContent = "";

  try {
    const password = String(deletePasswordInput.value || "").trim();
    await deleteRecordWithGuard(pendingDeleteRecordId, password);
    closeDeleteConfirmModal();
    setFeedback("Registro removido.");
    await loadRecords();
  } catch (error) {
    const payload = error.payload || {};
    if (payload.requiresPassword) {
      deletePasswordWrap.hidden = false;
      deleteConfirmText.textContent = "Voce nao e o usuario que criou este dvr. Para excluir, informe a senha de admin.";
      deletePasswordInput.focus();
    }

    deleteConfirmError.textContent = error.message;
  } finally {
    confirmDeleteBtn.disabled = false;
  }
});

photoInput.addEventListener("change", async () => {
  if (!photoInput.files?.length) {
    photoFileName.textContent = "Nenhum arquivo selecionado";
    return;
  }

  photoFileName.textContent = photoInput.files[0].name;
  generatedQrCardUrl = "";

  const scannerPayload = new FormData();
  scannerPayload.append("photo", photoInput.files[0]);

  try {
    const result = await api("/api/scan-serial", {
      method: "POST",
      body: scannerPayload,
    });
    serialInput.value = result.serial || "";
    setFeedback("Serial lido automaticamente pelo QR.");
    await generateQrCardForSerial(result.serial || "");
  } catch (error) {
    setFeedback(`Nao foi possivel ler o QR: ${error.message}`, true);
  }
});

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isEditing = Boolean(editingRecordId);
  const endpoint = isEditing ? `/api/records/${editingRecordId}` : "/api/records";
  const method = isEditing ? "PUT" : "POST";

  function createBody(adminPassword = "") {
    const body = new FormData(recordForm);
    body.set("deviceId", deviceId);
    if (generatedQrCardUrl && !photoInput.files?.length) {
      body.set("qrCardImageUrl", generatedQrCardUrl);
    }
    if (adminPassword) {
      body.set("adminPassword", adminPassword);
    }
    return body;
  }

  try {
    await api(endpoint, {
      method,
      body: createBody(editAdminPassword),
    });
    setFeedback(isEditing ? "DVR atualizado com sucesso." : "DVR salvo com sucesso.");
    closeModal();
    await loadRecords();
  } catch (error) {
    if (isEditing && error.payload?.requiresPassword) {
      const password = window.prompt("Voce nao e o usuario que criou este dvr. Informe a senha de admin para editar:") || "";
      if (!String(password).trim()) {
        setFeedback(error.message, true);
        return;
      }

      try {
        editAdminPassword = String(password).trim();
        await api(endpoint, {
          method,
          body: createBody(editAdminPassword),
        });
        setFeedback("DVR atualizado com sucesso.");
        closeModal();
        await loadRecords();
        return;
      } catch (secondError) {
        setFeedback(secondError.message, true);
        return;
      }
    }

    setFeedback(error.message, true);
  }
});

recordsList.addEventListener("click", async (event) => {
  const image = event.target.closest("img.clickable-photo");
  if (image) {
    openImageModal(image.src, image.alt || "Imagem ampliada do DVR");
    return;
  }

  const editButton = event.target.closest("button.edit");
  if (editButton) {
    const id = editButton.dataset.id;
    const record = allRecords.find((r) => r.id === id);
    if (!record) return;

    editingRecordId = id;
    editAdminPassword = "";
    setModalMode(true);
    recordForm.elements.dvrName.value = record.dvrName || "";
    recordForm.elements.serial.value = record.serial || "";
    recordForm.elements.dvrLogin.value = record.dvrLogin || "";
    recordForm.elements.dvrPassword.value = record.dvrPassword || "";
    generatedQrCardUrl = "";
    photoFileName.textContent = "Nenhum arquivo selecionado";
    openModal();
    return;
  }

  const button = event.target.closest("button.delete");
  if (!button) return;

  const id = button.dataset.id;
  if (!id) return;

  const record = allRecords.find((r) => r.id === id);
  if (!record) return;
  openDeleteConfirmModal(record);
});

(async function bootstrap() {
  try {
    modal.hidden = true;
    await registerServiceWorker();
    await loadRecords();
  } catch (error) {
    setFeedback(error.message, true);
  }
})();
