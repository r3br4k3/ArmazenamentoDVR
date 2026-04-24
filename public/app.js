const feedback = document.getElementById("feedback");
const recordsList = document.getElementById("recordsList");
const searchInput = document.getElementById("searchInput");
const installAppBtn = document.getElementById("installAppBtn");
const modal = document.getElementById("modal");
const scannerModal = document.getElementById("scannerModal");
const imageModal = document.getElementById("imageModal");
const imageModalPreview = document.getElementById("imageModalPreview");
const closeImageModalBtn = document.getElementById("closeImageModalBtn");
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

let allRecords = [];
let editingRecordId = "";
let scannerStream = null;
let scannerAnimationId = 0;
let barcodeDetector = null;
let deferredInstallPrompt = null;
const overlayStack = [];

function pushOverlayState(type) {
  overlayStack.push(type);
  history.pushState({ overlay: type }, "");
}

function hideModalInternal() {
  modal.hidden = true;
  recordForm.reset();
  photoFileName.textContent = "Nenhum arquivo selecionado";
  editingRecordId = "";
  setModalMode(false);
}

function hideScannerInternal() {
  scannerModal.hidden = true;
  stopScanner();
}

function hideImageInternal() {
  imageModal.hidden = true;
  imageModalPreview.src = "";
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
    throw new Error(data.message || "Erro inesperado");
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

  drawRecords(recordsList, filtered, "Nenhum DVR encontrado na pesquisa.");
}

async function loadRecords() {
  const { records } = await api("/api/records");
  allRecords = records;
  applySearch();
}

addBtn.addEventListener("click", () => {
  setFeedback("");
  editingRecordId = "";
  setModalMode(false);
  openModal();
});

closeModalBtn.addEventListener("click", closeModal);
closeImageModalBtn.addEventListener("click", closeImageModal);
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

photoInput.addEventListener("change", async () => {
  if (!photoInput.files?.length) {
    photoFileName.textContent = "Nenhum arquivo selecionado";
    return;
  }

  photoFileName.textContent = photoInput.files[0].name;

  const scannerPayload = new FormData();
  scannerPayload.append("photo", photoInput.files[0]);

  try {
    const result = await api("/api/scan-serial", {
      method: "POST",
      body: scannerPayload,
    });
    serialInput.value = result.serial || "";
    setFeedback("Serial lido automaticamente pelo QR.");
  } catch (error) {
    setFeedback(`Nao foi possivel ler o QR: ${error.message}`, true);
  }
});

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = new FormData(recordForm);
  const isEditing = Boolean(editingRecordId);
  const endpoint = isEditing ? `/api/records/${editingRecordId}` : "/api/records";
  const method = isEditing ? "PUT" : "POST";

  try {
    await api(endpoint, {
      method,
      body,
    });
    setFeedback(isEditing ? "DVR atualizado com sucesso." : "DVR salvo com sucesso.");
    closeModal();
    await loadRecords();
  } catch (error) {
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
    setModalMode(true);
    recordForm.elements.dvrName.value = record.dvrName || "";
    recordForm.elements.serial.value = record.serial || "";
    recordForm.elements.dvrLogin.value = record.dvrLogin || "";
    recordForm.elements.dvrPassword.value = record.dvrPassword || "";
    photoFileName.textContent = "Nenhum arquivo selecionado";
    openModal();
    return;
  }

  const button = event.target.closest("button.delete");
  if (!button) return;

  const id = button.dataset.id;
  if (!id) return;

  try {
    await api(`/api/records/${id}`, { method: "DELETE" });
    setFeedback("Registro removido.");
    await loadRecords();
  } catch (error) {
    setFeedback(error.message, true);
  }
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
