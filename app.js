(() => {
  "use strict";

  const STORAGE_KEY = "voucher-print-form-v1";
  const MAX_ITEMS = 9;
  const ORIGINAL_DETAIL_ROWS = 8;

  const state = {
    unit: "",
    activity: "",
    year: "",
    month: "",
    day: "",
    handler: "",
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
    cashCheck: document.querySelector("#cashCheck"),
    transferCheck: document.querySelector("#transferCheck"),
    saveStatus: document.querySelector("#saveStatus"),
    toast: document.querySelector("#toast")
  };

  const textBindings = {
    unit: document.querySelector("#previewUnit"),
    activity: document.querySelector("#previewActivity"),
    year: document.querySelector("#previewYear"),
    month: document.querySelector("#previewMonth"),
    day: document.querySelector("#previewDay"),
    handler: document.querySelector("#previewHandler")
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

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 1900);
  }

  function persist() {
    window.clearTimeout(saveTimer);
    elements.saveStatus.textContent = "儲存中…";
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        elements.saveStatus.textContent = "已自動儲存";
      } catch {
        elements.saveStatus.textContent = "此瀏覽器無法儲存";
      }
    }, 220);
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return;
      Object.assign(state, saved);
      state.items = Array.isArray(saved.items) && saved.items.length
        ? saved.items.slice(0, MAX_ITEMS).map((item) => ({
            description: String(item.description ?? "").slice(0, 80),
            amount: String(item.amount ?? "").slice(0, 20)
          }))
        : state.items;
      if (!["", "cash", "transfer"].includes(state.payment)) state.payment = "";
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function syncControlsFromState() {
    ["unit", "activity", "year", "month", "day", "handler"].forEach((key) => {
      const input = document.querySelector(`#${key}`);
      if (input) input.value = state[key] ?? "";
    });
    const payment = elements.form.querySelector(`input[name="payment"][value="${CSS.escape(state.payment)}"]`);
    if (payment) payment.checked = true;
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

  function renderPreview() {
    Object.entries(textBindings).forEach(([key, node]) => {
      setPrintedText(node, state[key] || "");
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
    elements.cashCheck.textContent = state.payment === "cash" ? "✓" : "";
    elements.transferCheck.textContent = state.payment === "transfer" ? "✓" : "";
    elements.cashCheck.setAttribute("aria-label", state.payment === "cash" ? "現金已勾選" : "現金未勾選");
    elements.transferCheck.setAttribute("aria-label", state.payment === "transfer" ? "匯款帳號已勾選" : "匯款帳號未勾選");
    fitPrintedText();
  }

  function clearForm() {
    if (!window.confirm("確定要清除這張黏存單的全部內容嗎？")) return;
    Object.assign(state, {
      unit: "",
      activity: "",
      year: "",
      month: "",
      day: "",
      handler: "",
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
    showToast("表單內容已清除");
  }

  function bindFormEvents() {
    ["unit", "activity", "year", "month", "day", "handler"].forEach((key) => {
      document.querySelector(`#${key}`).addEventListener("input", (event) => {
        state[key] = event.currentTarget.value;
        renderPreview();
        persist();
      });
    });
    elements.form.querySelectorAll('input[name="payment"]').forEach((radio) => {
      radio.addEventListener("change", (event) => {
        if (!event.currentTarget.checked) return;
        state.payment = event.currentTarget.value;
        renderPreview();
        persist();
      });
    });
    document.querySelector("#addItemButton").addEventListener("click", addItem);
    document.querySelector("#clearButton").addEventListener("click", clearForm);
    document.querySelector("#printButton").addEventListener("click", () => window.print());
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    try {
      void Promise.resolve(context.registerTool({
        name: "fill_voucher_form",
        title: "填寫憑證黏存單",
        description: "將單位、活動、日期、經手人、明細與付款方式填入目前的憑證黏存單，並更新完整表單預覽。",
        inputSchema: {
          type: "object",
          properties: {
            unit: { type: "string", maxLength: 18 },
            activity: { type: "string", maxLength: 30 },
            year: { type: "string", maxLength: 4 },
            month: { type: "string", maxLength: 2 },
            day: { type: "string", maxLength: 2 },
            handler: { type: "string", maxLength: 12 },
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
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("輸入格式不正確");
          ["unit", "activity", "year", "month", "day", "handler", "payment"].forEach((key) => {
            if (Object.hasOwn(input, key)) state[key] = input[key];
          });
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
  syncControlsFromState();
  renderDetailsEditor();
  renderPreview();
  bindFormEvents();
  window.addEventListener("beforeprint", fitPrintedText);
  window.addEventListener("afterprint", fitPrintedText);
  window.addEventListener("resize", fitPrintedText);
  if (typeof ResizeObserver !== "undefined") {
    const paperObserver = new ResizeObserver(fitPrintedText);
    paperObserver.observe(document.querySelector("#paper"));
  }
  document.fonts?.ready.then(fitPrintedText);
  registerWebMcp();
})();
