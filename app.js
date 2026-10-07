(() => {
  "use strict";

  const STORAGE_KEY = "voucher-print-form-v1";
  const MAX_ITEMS = 9;
  const ORIGINAL_DETAIL_ROWS = 8;
  const recordsApi = window.VoucherRecords;
  const recordStore = new recordsApi.RecordStore();
  let activeRecord = null;
  let savedFingerprint = null;
  let recordLabel = "";
  let recordVersionNumber = 0;
  let operationQueue = Promise.resolve();
  let pendingOperations = 0;
  let printSession = null;
  let historyRecords = [];
  let historyPage = 0;
  const HISTORY_PAGE_SIZE = 20;
  const CHECK_GROUPS = {"receipt":["receiptCash","receiptCheque","receiptTransfer","receiptOther"],"offset":["advance","requestedDifference","returnedDifference"],"payment":["paymentCash","paymentCheque","paymentTransfer"]};
  const OPTION_FIELDS = {"receiptAccount":"receiptTransfer","receiptOther":"receiptOther","advanceAmount":"advance","requestedDifference":"requestedDifference","returnedDifference":"returnedDifference","paymentCheckNumber":"paymentCheque","paymentAccount":"paymentTransfer"};

  const state = {
    unit: "",
    activity: "",
    year: "",
    month: "",
    day: "",
    handler: "",
    vendor: "",
    checks: Object.fromEntries(recordsApi.CHECK_FIELDS.map(key => [key, false])),
    receiptAccount: "",
    receiptOther: "",
    advanceAmount: "",
    requestedDifference: "",
    returnedDifference: "",
    paymentCheckNumber: "",
    paymentAccount: "",
    payment: "",
    items: [
      { description: "", amount: "" },
      { description: "", amount: "" },
      { description: "", amount: "" }
    ]
  };

  const elements = {
    form: document.querySelector("#voucherForm"),
    detailsList: document.querySelector("#detailsList"),
    formTotal: document.querySelector("#formTotal"),
    previewDetails: document.querySelector("#previewDetails"),
    previewTotal: document.querySelector("#previewTotal"),
    printOverlay: document.querySelector("#printOverlay"),
    saveStatus: document.querySelector("#saveStatus"),
    toast: document.querySelector("#toast")
  };

  const textBindings = {
    unit: document.querySelector("#previewUnit"),
    activity: document.querySelector("#previewActivity"),
    year: document.querySelector("#previewYear"),
    month: document.querySelector("#previewMonth"),
    day: document.querySelector("#previewDay"),
    handler: document.querySelector("#previewHandler"),
    vendor: document.querySelector("#previewVendor"),
    receiptAccount: document.querySelector("#previewReceiptAccount"),
    receiptOther: document.querySelector("#previewReceiptOther"),
    advanceAmount: document.querySelector("#previewAdvanceAmount"),
    requestedDifference: document.querySelector("#previewRequestedDifference"),
    returnedDifference: document.querySelector("#previewReturnedDifference"),
    paymentCheckNumber: document.querySelector("#previewPaymentCheckNumber"),
    paymentAccount: document.querySelector("#previewPaymentAccount")
  };

  const numberFormatter = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
  let toastTimer = 0;
  let saveTimer = 0;

  // Keep the full text inside its measured cell. Paper-relative font units also
  // preserve the same proportions in the responsive preview and A4 printout.
  function setPrintedText(node, value) {
    const text = document.createElement("span");
    text.className = "printed-text";
    text.textContent = String(value ?? "");
    node.replaceChildren(text);
  }

  function fitPrintedText() {
    elements.printOverlay.querySelectorAll(".printed-field, .printed-detail").forEach((node) => {
      const text = node.querySelector(".printed-text");
      if (!text) return;
      node.style.setProperty("--fit-ratio", "1");
      const style = window.getComputedStyle(node);
      const available = node.getBoundingClientRect().width
        - (parseFloat(style.paddingLeft) || 0)
        - (parseFloat(style.paddingRight) || 0);
      const natural = text.getBoundingClientRect().width;
      if (available > 0 && natural > available) {
        // Leave a small rounding allowance so the last glyph is never clipped.
        node.style.setProperty("--fit-ratio", String(Math.max(0.01, (available - 1) / natural)));
      }
    });
  }

  function parseAmount(value) {
    const cleaned = String(value ?? "").replace(/,/g, "").replace(/[^0-9.-]/g, "");
    const amount = Number(cleaned);
    return Number.isFinite(amount) ? amount : 0;
  }

  function formatAmount(value) {
    const amount = parseAmount(value);
    return amount ? numberFormatter.format(amount) : "";
  }

  function totalAmount() {
    return state.items.reduce((sum, item) => sum + parseAmount(item.amount), 0);
  }

  function showToast(message, duration = 2600) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), duration);
  }

  function persist() {
    window.clearTimeout(saveTimer);
    elements.saveStatus.textContent = "儲存中…";
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, recordRef: activeRecord }));
        elements.saveStatus.textContent = "草稿已自動儲存";
      } catch {
        elements.saveStatus.textContent = "此瀏覽器無法儲存";
      }
    }, 220);
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return;
      Object.assign(state, recordsApi.normalizeSnapshot(saved));
      if (saved.recordRef && typeof saved.recordRef.id === "string" && typeof saved.recordRef.versionId === "string") activeRecord = { id: saved.recordRef.id, versionId: saved.recordRef.versionId };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function singleSelectChecks() {
    let changed = false;
    for (const keys of Object.values(CHECK_GROUPS)) {
      const selected = keys.find(key => state.checks[key]);
      for (const key of keys) {
        const checked = key === selected;
        if (state.checks[key] !== checked) changed = true;
        state.checks[key] = checked;
      }
    }
    state.payment = recordsApi.normalizeSnapshot(state).payment;
    return changed;
  }

  function syncControlsFromState() {
    const converted = singleSelectChecks();
    Object.keys(textBindings).forEach((key) => {
      const input = document.querySelector(`#${key}`);
      if (input) input.value = state[key] ?? "";
    });
    elements.form.querySelectorAll("input[data-check]").forEach(input => {
      input.checked = input.dataset.check ? state.checks[input.dataset.check] : !CHECK_GROUPS[input.dataset.checkGroup].some(key => state.checks[key]);
    });
    return converted;
  }

  function renderDetailsEditor() {
    elements.detailsList.replaceChildren();
    state.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "detail-row";
      row.innerHTML = `
        <label class="detail-description-wrap">
          <span class="detail-number">${index + 1}</span>
          <input class="detail-description" type="text" maxlength="80" aria-label="第 ${index + 1} 筆內容及摘要" placeholder="請輸入內容及摘要">
        </label>
        <input class="detail-amount" type="text" inputmode="decimal" maxlength="20" aria-label="第 ${index + 1} 筆金額" placeholder="0">
        <button class="remove-item" type="button" aria-label="刪除第 ${index + 1} 筆">×</button>`;

      const descriptionInput = row.querySelector(".detail-description");
      const amountInput = row.querySelector(".detail-amount");
      descriptionInput.value = item.description;
      amountInput.value = item.amount;

      descriptionInput.addEventListener("input", (event) => {
        state.items[index].description = event.currentTarget.value;
        renderPreview();
        persist();
      });
      amountInput.addEventListener("input", (event) => {
        state.items[index].amount = event.currentTarget.value;
        renderPreview();
        persist();
      });
      amountInput.addEventListener("blur", (event) => {
        const formatted = formatAmount(event.currentTarget.value);
        state.items[index].amount = formatted;
        event.currentTarget.value = formatted;
        renderPreview();
        persist();
      });
      row.querySelector(".remove-item").addEventListener("click", () => removeItem(index));
      elements.detailsList.append(row);
    });
    document.querySelector("#addItemButton").disabled = state.items.length >= MAX_ITEMS;
  }

  function addItem() {
    if (state.items.length >= MAX_ITEMS) {
      showToast("黏存單最多可填 9 筆明細");
      return;
    }
    state.items.push({ description: "", amount: "" });
    renderDetailsEditor();
    renderPreview();
    persist();
    const lastInput = elements.detailsList.querySelector(".detail-row:last-child .detail-description");
    lastInput?.focus();
  }

  function removeItem(index) {
    if (state.items.length === 1) {
      state.items[0] = { description: "", amount: "" };
    } else {
      state.items.splice(index, 1);
    }
    renderDetailsEditor();
    renderPreview();
    persist();
  }

  function updateOptionInputs() {
    for (const [field, check] of Object.entries(OPTION_FIELDS)) {
      document.querySelector(`#${field}`).disabled = Boolean(printSession) || !state.checks[check];
    }
  }

  function renderPreview() {
    updateOptionInputs();
    Object.entries(textBindings).forEach(([key, node]) => {
      const check = OPTION_FIELDS[key];
      setPrintedText(node, check && !state.checks[check] ? "" : state[key] || "");
    });

    elements.previewDetails.replaceChildren();
    // The Excel original has eight rows. A ninth existing item gets its own
    // row within the same table height, keeping the total and remarks in place.
    const rowCount = Math.max(ORIGINAL_DETAIL_ROWS, state.items.length);
    elements.printOverlay.style.setProperty("--detail-row-height", `calc(${33.28 / rowCount} * var(--paper-unit))`);
    for (let index = 0; index < rowCount; index += 1) {
      const item = state.items[index] || { description: "", amount: "" };
      const row = document.createElement("tr");
      const descriptionCell = document.createElement("td");
      descriptionCell.colSpan = 4;
      const amountCell = document.createElement("td");
      const description = document.createElement("span");
      description.className = "printed-detail printed-detail-description";
      setPrintedText(description, item.description || "");

      const amount = document.createElement("span");
      amount.className = "printed-detail printed-detail-amount";
      setPrintedText(amount, formatAmount(item.amount));
      descriptionCell.append(description);
      amountCell.append(amount);
      row.append(descriptionCell, amountCell);
      elements.previewDetails.append(row);
    }

    const total = totalAmount();
    const totalText = total ? numberFormatter.format(total) : "";
    setPrintedText(elements.previewTotal, totalText);
    elements.formTotal.textContent = `NT$ ${totalText || "0"}`;
    elements.printOverlay.querySelectorAll("[data-print-check]").forEach(node => {
      const checked = state.checks[node.dataset.printCheck];
      node.textContent = checked ? "✓" : "";
      node.setAttribute("aria-label", `${node.dataset.checkLabel}${checked ? "已勾選" : "未勾選"}`);
    });
    fitPrintedText();
    renderRecordContext();
  }

  function clearForm() {
    if (!allowReplaceDraft("開始新的黏存單")) return;
    activeRecord = null;
    savedFingerprint = null;
    recordLabel = "";
    recordVersionNumber = 0;
    Object.assign(state, {
      unit: "",
      activity: "",
      year: "",
      month: "",
      day: "",
      handler: "",
      vendor: "",
      checks: Object.fromEntries(recordsApi.CHECK_FIELDS.map(key => [key, false])),
      receiptAccount: "",
      receiptOther: "",
      advanceAmount: "",
      requestedDifference: "",
      returnedDifference: "",
      paymentCheckNumber: "",
      paymentAccount: "",
      payment: "",
      items: [
        { description: "", amount: "" },
        { description: "", amount: "" },
        { description: "", amount: "" }
      ]
    });
    syncControlsFromState();
    renderDetailsEditor();
    renderPreview();
    persist();
    showToast("已開始新的黏存單，歷史紀錄仍保留");
  }

  function bindFormEvents() {
    Object.keys(textBindings).forEach((key) => {
      document.querySelector(`#${key}`).addEventListener("input", (event) => {
        state[key] = event.currentTarget.value;
        renderPreview();
        persist();
      });
    });
    elements.form.querySelectorAll("input[data-check]").forEach(input => {
      input.addEventListener("change", event => {
        if (!event.currentTarget.checked) return;
        const { check, checkGroup } = event.currentTarget.dataset;
        for (const key of CHECK_GROUPS[checkGroup]) state.checks[key] = key === check;
        state.payment = recordsApi.normalizeSnapshot(state).payment;
        renderPreview();
        persist();
      });
    });
    document.querySelector("#addItemButton").addEventListener("click", addItem);
    document.querySelector("#clearButton").addEventListener("click", clearForm);
    document.querySelector("#printButton").addEventListener("click", saveAndPrint);
  }

  function renderRecordContext() {
    const node = document.querySelector("#recordContext");
    if (!activeRecord) node.textContent = "新黏存單・尚未存入紀錄庫";
    else if (!recordLabel) node.textContent = "正在讀取原紀錄…";
    else {
      const changed = savedFingerprint !== recordsApi.fingerprint(state);
      node.textContent = `${recordLabel}・第 ${recordVersionNumber} 版${changed ? "・已修改，儲存後保留為新版本" : "・已存入紀錄庫"}`;
    }
  }

  function allowReplaceDraft(action) {
    const snapshot = recordsApi.normalizeSnapshot(state);
    const hasContent = Object.entries(snapshot).some(([key, value]) => key === "items" ? value.some(item => item.description || item.amount) : key === "checks" ? Object.values(value).some(Boolean) : Boolean(value));
    if (!hasContent || recordsApi.fingerprint(snapshot) === savedFingerprint) return true;
    return window.confirm(`目前尚未存入紀錄的內容會被取代。確定要${action}嗎？`);
  }

  function storageError(error) {
    const message = error?.name === "QuotaExceededError" ? "本機儲存空間不足，尚未存入紀錄。請先匯出備份，再整理舊紀錄。" : `紀錄操作未完成：${error?.message || "請重新整理後再試"}`;
    showToast(message, 6500);
    return message;
  }

  function updateBusy() {
    const printing = Boolean(printSession);
    for (const id of ["saveRecordButton", "printButton", "clearButton", "exportBackupButton", "importBackupButton"]) document.querySelector(`#${id}`).disabled = pendingOperations > 0 || printing;
    for (const control of elements.form.elements) control.disabled = printing;
    updateOptionInputs();
    if (!printing) document.querySelector("#addItemButton").disabled = state.items.length >= MAX_ITEMS;
  }

  function queueOperation(work) {
    pendingOperations++;
    updateBusy();
    const result = operationQueue.then(work);
    operationQueue = result.catch(() => {});
    return result.finally(() => { pendingOperations--; updateBusy(); });
  }

  function saveCurrent(printRequested = false) {
    const snapshot = recordsApi.normalizeSnapshot(state);
    return queueOperation(async () => {
      const result = await recordStore.save(snapshot, activeRecord, printRequested);
      activeRecord = { id: result.record.id, versionId: result.version.id };
      recordLabel = result.record.number;
      recordVersionNumber = result.version.number;
      savedFingerprint = recordsApi.fingerprint(result.version.snapshot);
      renderRecordContext();
      persist();
      showToast(printRequested ? `${recordLabel} 已儲存，已記錄本次開啟列印` : `${recordLabel} 第 ${recordVersionNumber} 版已儲存`);
      if (document.querySelector("#historyDialog").open) await refreshHistory();
      return result;
    });
  }

  async function saveAndPrint() {
    if (printSession || pendingOperations) return;
    const session = {};
    printSession = session;
    updateBusy();
    try {
      await saveCurrent(true);
      if (document.fonts) await document.fonts.ready;
      fitPrintedText();
      window.print();
    } catch (error) { storageError(error); }
    finally { if (printSession === session) printSession = null; updateBusy(); }
  }

  function handleBeforePrint() {
    fitPrintedText();
    if (printSession) return;
    const session = {};
    printSession = session;
    updateBusy();
    // Also retain a snapshot when the browser's Ctrl+P/menu starts printing.
    // Browser print completion is not proof of a successful paper print.
    saveCurrent(true).catch(storageError);
  }

  const displayTime = value => new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  function makeNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function recordButton(text, action, danger = false) {
    const button = makeNode("button", `button button-secondary${danger ? " record-delete" : ""}`, text);
    button.type = "button";
    button.addEventListener("click", () => {
      if (pendingOperations || printSession) { showToast("請稍候，紀錄正在儲存或列印"); return; }
      Promise.resolve().then(action).catch(storageError);
    });
    return button;
  }

  async function loadRecord(id, versionId) {
    const record = await queueOperation(() => recordStore.get(id));
    const version = record?.versions.find(v => v.id === versionId);
    if (!version) throw new Error("這份紀錄已不存在，請重新開啟紀錄庫");
    if (!allowReplaceDraft("載入此紀錄")) return false;
    Object.assign(state, recordsApi.normalizeSnapshot(version.snapshot));
    activeRecord = { id, versionId };
    recordLabel = record.number;
    recordVersionNumber = version.number;
    savedFingerprint = recordsApi.fingerprint(version.snapshot);
    const converted = syncControlsFromState();
    renderDetailsEditor();
    renderPreview();
    persist();
    document.querySelector("#historyDialog").close();
    showToast(`已載入 ${record.number} 第 ${version.number} 版${converted ? "；舊複選已改為每列單選，儲存會保留為新版本" : ""}`, converted ? 6500 : 2600);
    return true;
  }

  function renderHistory() {
    const query = document.querySelector("#historySearch").value.trim().toLocaleLowerCase();
    const start = document.querySelector("#historyStart").value.replace(/-/g, "");
    const end = document.querySelector("#historyEnd").value.replace(/-/g, "");
    const filtered = historyRecords.filter(record => {
      // A date matches any saved version; older revisions remain searchable.
      const matchesDate = record.versions.some(version => {
        const stamp = recordsApi.dayStamp(new Date(version.savedAt));
        return (!start || stamp >= start) && (!end || stamp <= end);
      });
      const searchable = [record.number, ...record.versions.flatMap(version => [version.snapshot.unit, version.snapshot.activity, version.snapshot.handler, version.snapshot.vendor || "", version.snapshot.receiptAccount || "", version.snapshot.receiptOther || "", version.snapshot.advanceAmount || "", version.snapshot.requestedDifference || "", version.snapshot.returnedDifference || "", version.snapshot.paymentCheckNumber || "", version.snapshot.paymentAccount || "", ...version.snapshot.items.map(item => item.description)])].join(" ").toLocaleLowerCase();
      return matchesDate && (!query || searchable.includes(query));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number.localeCompare(a.number));
    const pageCount = Math.max(1, Math.ceil(filtered.length / HISTORY_PAGE_SIZE));
    historyPage = Math.max(0, Math.min(historyPage, pageCount - 1));
    const list = document.querySelector("#historyList");
    list.replaceChildren();
    document.querySelector("#historySummary").textContent = `共 ${historyRecords.length} 張黏存單・符合篩選 ${filtered.length} 張。修改後儲存會保留舊版本；「標記已列印」由你確認紙張已印出。`;
    if (!filtered.length) list.append(makeNode("p", "history-empty", historyRecords.length ? "沒有符合條件的紀錄，請調整搜尋或日期。" : "目前尚無紀錄。填寫完成後，按「儲存紀錄」或「儲存並列印」即可加入。"));
    for (const record of filtered.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE)) {
      const article = makeNode("article", "record-card");
      article.dataset.recordId = record.id;
      const header = makeNode("div", "record-card-header");
      const number = makeNode("strong", "", record.number);
      const amount = makeNode("span", "record-card-amount");
      header.append(number, amount);
      const title = makeNode("p", "record-card-title");
      const meta = makeNode("p", "record-card-meta");
      const status = makeNode("p", "record-card-meta");
      const actions = makeNode("div", "record-actions");
      const select = makeNode("select", "record-version-select");
      select.setAttribute("aria-label", `${record.number} 版本`);
      for (const version of record.versions.slice().reverse()) {
        const option = makeNode("option", "", `第 ${version.number} 版・${displayTime(version.savedAt)}`);
        option.value = version.id;
        select.append(option);
      }
      const chosen = () => record.versions.find(version => version.id === select.value);
      const confirm = recordButton("標記已列印", async () => {
        const version = chosen();
        const event = version.printEvents.slice().reverse().find(e => !e.confirmedAt);
        if (!event) return;
        await queueOperation(() => recordStore.confirmPrint(record.id, version.id, event.id));
        await refreshHistory();
        showToast("已標記這次列印完成");
      });
      function updateCard() {
        const version = chosen();
        const snapshot = recordsApi.normalizeSnapshot(version.snapshot);
        const total = snapshot.items.reduce((sum, item) => sum + parseAmount(item.amount), 0);
        title.textContent = `${snapshot.unit || "未填單位"} / ${snapshot.activity || "未填活動名稱"}`;
        amount.textContent = `NT$ ${numberFormatter.format(total)}`;
        const paymentText = [["paymentCash", "現金"], ["paymentCheque", "支票"], ["paymentTransfer", "匯款帳號"]].filter(([key]) => snapshot.checks[key]).map(([, label]) => label).join("、") || "未勾選";
        meta.textContent = `單據日期：${snapshot.year || "—"}/${snapshot.month || "—"}/${snapshot.day || "—"}・經手人：${snapshot.handler || "—"}・廠商：${snapshot.vendor || "—"}・付款：${paymentText}・首次儲存：${displayTime(record.createdAt)}`;
        const confirmed = version.printEvents.filter(event => event.confirmedAt).length;
        const lastPrint = version.printEvents.at(-1);
        status.textContent = `${record.versions.length} 個版本・本版開啟列印 ${version.printEvents.length} 次・已確認 ${confirmed} 次${lastPrint ? `・最近開啟列印：${displayTime(lastPrint.requestedAt)}` : ""}${record.originalNumber ? `・匯入前編號：${record.originalNumber}` : ""}`;
        confirm.disabled = version.printEvents.every(event => event.confirmedAt);
      }
      select.addEventListener("change", updateCard);
      actions.append(select,
        recordButton("載入修改", () => loadRecord(record.id, chosen().id)),
        recordButton("重新列印", async () => { if (await loadRecord(record.id, chosen().id)) await saveAndPrint(); }),
        confirm,
        recordButton("刪除", async () => {
          if (!window.confirm(`刪除 ${record.number} 的全部版本與列印紀錄？此操作無法復原，請先匯出備份。`)) return;
          await queueOperation(() => recordStore.remove(record.id));
          if (activeRecord?.id === record.id) { activeRecord = null; savedFingerprint = null; recordLabel = ""; renderRecordContext(); persist(); }
          await refreshHistory();
          showToast("已刪除此黏存單紀錄");
        }, true));
      article.append(header, title, meta, status, actions);
      updateCard();
      list.append(article);
    }
    document.querySelector("#previousHistoryPage").disabled = historyPage === 0;
    document.querySelector("#nextHistoryPage").disabled = historyPage >= pageCount - 1;
    document.querySelector("#historyPageLabel").textContent = `第 ${historyPage + 1} / ${pageCount} 頁`;
  }

  async function refreshHistory() {
    const [records, lastExport] = await Promise.all([recordStore.list(), recordStore.lastExport()]);
    historyRecords = records;
    document.querySelector("#backupStatus").textContent = lastExport ? `最近匯出：${displayTime(lastExport)}` : "尚未匯出備份";
    renderHistory();
  }

  async function exportBackup() {
    await queueOperation(async () => {
      const backup = await recordStore.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = makeNode("a");
      link.href = url;
      link.download = `黏存單備份_${recordsApi.dayStamp(new Date(backup.exportedAt))}_${backup.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      await recordStore.noteExport(backup.exportedAt);
      await refreshHistory();
      showToast(`已匯出 ${backup.records.length} 張黏存單，包含所有版本與列印紀錄`);
    });
  }

  async function importBackup(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error("備份檔超過 25 MB，請分批整理後再匯入");
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error("備份檔不是有效的 JSON，請選擇由紀錄庫匯出的備份檔"); }
    const backup = recordsApi.validateBackup(parsed);
    if (!window.confirm(`備份含 ${backup.records.length} 張黏存單。匯入會合併版本與列印紀錄，不會刪除現有資料。確定匯入？`)) return;
    const stats = await queueOperation(() => recordStore.importBackup(backup));
    await refreshHistory();
    showToast(`匯入完成：新增 ${stats.added} 張、合併 ${stats.merged} 張、略過 ${stats.skipped} 張${stats.renumbered ? `；${stats.renumbered} 張同號紀錄已重新編號` : ""}`);
  }

  function bindRecordEvents() {
    document.querySelector("#saveRecordButton").addEventListener("click", () => saveCurrent().catch(storageError));
    document.querySelector("#historyButton").addEventListener("click", async () => {
      document.querySelector("#historySummary").textContent = "正在載入紀錄…";
      document.querySelector("#historyList").replaceChildren();
      document.querySelector("#historyDialog").showModal();
      try { await refreshHistory(); } catch (error) { document.querySelector("#historySummary").textContent = storageError(error); }
    });
    document.querySelector("#closeHistoryButton").addEventListener("click", () => document.querySelector("#historyDialog").close());
    document.querySelector("#exportBackupButton").addEventListener("click", () => exportBackup().catch(storageError));
    document.querySelector("#importBackupButton").addEventListener("click", () => document.querySelector("#backupFile").click());
    document.querySelector("#backupFile").addEventListener("change", event => {
      const file = event.currentTarget.files[0];
      event.currentTarget.value = "";
      importBackup(file).catch(storageError);
    });
    for (const id of ["historySearch", "historyStart", "historyEnd"]) document.querySelector(`#${id}`).addEventListener("input", () => { historyPage = 0; renderHistory(); });
    document.querySelector("#resetHistoryFilters").addEventListener("click", () => {
      for (const id of ["historySearch", "historyStart", "historyEnd"]) document.querySelector(`#${id}`).value = "";
      historyPage = 0;
      renderHistory();
    });
    document.querySelector("#previousHistoryPage").addEventListener("click", () => { historyPage--; renderHistory(); });
    document.querySelector("#nextHistoryPage").addEventListener("click", () => { historyPage++; renderHistory(); });
    window.addEventListener("storage", event => { if (event.key === STORAGE_KEY) showToast("另一個分頁更新了草稿；此頁的填寫內容仍保留，請避免同時編輯同一張單。"); });
    window.addEventListener("focus", () => { if (document.querySelector("#historyDialog").open) refreshHistory().catch(storageError); });
    recordStore.open().then(async () => {
      if (!activeRecord) return;
      const reference = { ...activeRecord };
      const record = await recordStore.get(reference.id);
      if (activeRecord?.id !== reference.id || activeRecord?.versionId !== reference.versionId) return;
      const version = record?.versions.find(v => v.id === reference.versionId);
      if (!version) { activeRecord = null; savedFingerprint = null; persist(); }
      else { recordLabel = record.number; recordVersionNumber = version.number; savedFingerprint = recordsApi.fingerprint(version.snapshot); }
      renderRecordContext();
    }).catch(storageError);
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    try {
      void Promise.resolve(context.registerTool({
        name: "fill_voucher_form",
        title: "填寫憑證黏存單",
        description: "將單位、活動、日期、經手人、廠商、明細、備註與收款／沖銷／付款勾選填入目前的憑證黏存單，並更新完整表單預覽。",
        inputSchema: {
          type: "object",
          properties: {
            unit: { type: "string", maxLength: 18 },
            activity: { type: "string", maxLength: 30 },
            year: { type: "string", maxLength: 4 },
            month: { type: "string", maxLength: 2 },
            day: { type: "string", maxLength: 2 },
            handler: { type: "string", maxLength: 12 },
            vendor: { type: "string", maxLength: 40 },
            checks: { type: "object", properties: Object.fromEntries(recordsApi.CHECK_FIELDS.map(key => [key, { type: "boolean" }])), additionalProperties: false },
            receiptAccount: { type: "string", maxLength: 40 },
            receiptOther: { type: "string", maxLength: 60 },
            advanceAmount: { type: "string", maxLength: 20 },
            requestedDifference: { type: "string", maxLength: 20 },
            returnedDifference: { type: "string", maxLength: 20 },
            paymentCheckNumber: { type: "string", maxLength: 40 },
            paymentAccount: { type: "string", maxLength: 40 },
            payment: { type: "string", enum: ["cash", "transfer", ""] },
            items: {
              type: "array",
              maxItems: MAX_ITEMS,
              items: {
                type: "object",
                properties: {
                  description: { type: "string", maxLength: 80 },
                  amount: { type: ["number", "string"] }
                },
                required: ["description", "amount"],
                additionalProperties: false
              }
            }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (printSession) throw new Error("列印期間請稍候再修改內容");
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("輸入格式不正確");
          if (Object.hasOwn(input, "checks") && (!input.checks || typeof input.checks !== "object" || Array.isArray(input.checks) || Object.entries(input.checks).some(([key, value]) => !recordsApi.CHECK_FIELDS.includes(key) || typeof value !== "boolean"))) throw new Error("勾選資料格式不正確");
          if (input.checks && Object.values(CHECK_GROUPS).some(keys => keys.filter(key => input.checks[key] === true).length > 1)) throw new Error("收款、沖銷、付款每列只能選一項");
          [...Object.keys(textBindings), "payment"].forEach((key) => {
            if (Object.hasOwn(input, key)) state[key] = input[key];
          });
          if (Object.hasOwn(input, "payment")) {
            state.checks.paymentCash = input.payment === "cash";
            state.checks.paymentTransfer = input.payment === "transfer";
            state.checks.paymentCheque = false;
          }
          if (Object.hasOwn(input, "checks")) {
            for (const keys of Object.values(CHECK_GROUPS)) {
              const selected = keys.find(key => input.checks[key] === true);
              for (const key of keys) {
                if (selected) state.checks[key] = key === selected;
                else if (Object.hasOwn(input.checks, key)) state.checks[key] = input.checks[key];
              }
            }
          }
          state.payment = recordsApi.normalizeSnapshot(state).payment;
          if (Object.hasOwn(input, "items")) {
            if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) throw new Error("明細必須是最多 9 筆的陣列");
            state.items = input.items.length
              ? input.items.map((item) => ({ description: String(item.description), amount: String(item.amount) }))
              : [{ description: "", amount: "" }];
          }
          syncControlsFromState();
          renderDetailsEditor();
          renderPreview();
          persist();
          return { updated: true, itemCount: state.items.length, total: totalAmount() };
        }
      }));
    } catch {
      // WebMCP is optional; the visible form remains fully functional.
    }
  }

  restore();
  const convertedDraft = syncControlsFromState();
  if (convertedDraft) {
    persist();
    showToast("舊草稿的複選已改為每列單選，請確認各列選項。", 6500);
  }
  renderDetailsEditor();
  renderPreview();
  bindFormEvents();
  bindRecordEvents();
  window.addEventListener("beforeprint", handleBeforePrint);
  window.addEventListener("afterprint", () => { printSession = null; updateBusy(); fitPrintedText(); });
  window.addEventListener("resize", fitPrintedText);
  if (typeof ResizeObserver !== "undefined") {
    const paperObserver = new ResizeObserver(fitPrintedText);
    paperObserver.observe(document.querySelector("#paper"));
  }
  document.fonts?.ready.then(fitPrintedText);
  registerWebMcp();
})();
