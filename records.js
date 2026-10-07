(function (root) {
  "use strict";

  const FORMAT = "voucher-print-form-backup";
  const FIELDS = { unit: 18, activity: 30, year: 4, month: 2, day: 2, handler: 12 };
  const OPTIONAL_FIELDS = { receiptAccount: 40, receiptOther: 60, advanceAmount: 20, requestedDifference: 20, returnedDifference: 20, paymentCheckNumber: 40, paymentAccount: 40, vendor: 40 };
  const CHECK_FIELDS = ["receiptCash","receiptCheque","receiptTransfer","receiptOther","advance","requestedDifference","returnedDifference","paymentCash","paymentCheque","paymentTransfer"];
  const copy = value => JSON.parse(JSON.stringify(value));
  const uid = () => root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const time = () => new Date().toISOString();
  const fail = message => { throw new Error(message); };

  function normalizeSnapshot(value, strict = false) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("黏存單內容格式不正確");
    const snapshot = {};
    for (const [key, length] of Object.entries({ ...FIELDS, ...OPTIONAL_FIELDS })) {
      if (strict && (value[key] !== undefined || !Object.hasOwn(OPTIONAL_FIELDS, key)) && (typeof value[key] !== "string" || value[key].length > length)) fail(`備份中的 ${key} 欄位格式不正確`);
      snapshot[key] = String(value[key] ?? "").slice(0, length);
    }
    if (strict && !["", "cash", "transfer"].includes(value.payment)) fail("備份中的付款方式不正確");
    const legacyPayment = ["", "cash", "transfer"].includes(value.payment) ? value.payment : "";
    const hasChecks = value.checks !== null && typeof value.checks === "object" && !Array.isArray(value.checks);
    if (strict && value.checks !== undefined && !hasChecks) fail("備份中的勾選資料格式不正確");
    if (strict && hasChecks && Object.keys(value.checks).some(key => !CHECK_FIELDS.includes(key))) fail("備份含不支援的勾選欄位");
    snapshot.checks = Object.fromEntries(CHECK_FIELDS.map(key => {
      if (strict && hasChecks && value.checks[key] !== undefined && typeof value.checks[key] !== "boolean") fail("備份中的勾選值必須為 true 或 false");
      const checked = hasChecks ? value.checks[key] === true : (key === "paymentCash" && legacyPayment === "cash") || (key === "paymentTransfer" && legacyPayment === "transfer");
      return [key, checked];
    }));
    snapshot.payment = snapshot.checks.paymentCash && !snapshot.checks.paymentTransfer ? "cash" : snapshot.checks.paymentTransfer && !snapshot.checks.paymentCash ? "transfer" : "";
    if (strict && (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 9)) fail("備份中的明細筆數不正確");
    snapshot.items = (Array.isArray(value.items) && value.items.length ? value.items : [{ description: "", amount: "" }]).slice(0, 9).map(item => {
      if (!item || typeof item !== "object") fail("明細內容格式不正確");
      if (strict && (typeof item.description !== "string" || item.description.length > 80 || typeof item.amount !== "string" || item.amount.length > 20)) fail("備份中的明細欄位格式不正確");
      return { description: String(item.description ?? "").slice(0, 80), amount: String(item.amount ?? "").slice(0, 20) };
    });
    return snapshot;
  }

  const fingerprint = snapshot => JSON.stringify(normalizeSnapshot(snapshot));
  function dayStamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = type => parts.find(p => p.type === type).value;
    return part("year") + part("month") + part("day");
  }
  function validId(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) fail("備份中的識別碼不正確");
    return value;
  }
  function validTime(value) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail("備份中的時間格式不正確");
    return new Date(value).toISOString();
  }
  function unique(values, label) {
    if (new Set(values).size !== values.length) fail(`備份含重複的${label}`);
  }

  function validateBackup(value) {
    if (!value || value.format !== FORMAT || ![1, 2, 3].includes(value.schemaVersion) || !Array.isArray(value.records)) fail("請選擇由黏存單紀錄庫匯出的 JSON 備份檔");
    if (value.records.length > 20000) fail("備份筆數超過可匯入範圍");
    const records = value.records.map(record => {
      if (!record || typeof record !== "object" || !/^\d{8}-\d{3,8}$/.test(record.number || "")) fail("備份中的黏存單編號不正確");
      if (!Array.isArray(record.versions) || !record.versions.length || record.versions.length > 2000) fail("備份中的版本資料不正確");
      const versions = record.versions.map(version => {
        if (!version || !Number.isSafeInteger(version.number) || version.number < 1 || !Array.isArray(version.printEvents) || version.printEvents.length > 10000) fail("備份中的版本或列印紀錄不正確");
        const printEvents = version.printEvents.map(event => {
          const requestedAt = validTime(event.requestedAt);
          return { id: validId(event.id), requestedAt, confirmedAt: event.confirmedAt === null ? null : validTime(event.confirmedAt) };
        });
        unique(printEvents.map(event => event.id), "列印識別碼");
        return { id: validId(version.id), number: version.number, savedAt: validTime(version.savedAt), snapshot: normalizeSnapshot(version.snapshot, true), printEvents };
      }).sort((a, b) => a.number - b.number);
      unique(versions.map(version => version.id), "版本識別碼");
      unique(versions.map(version => version.number), "版本號碼");
      const normalized = { id: validId(record.id), number: record.number, createdAt: validTime(record.createdAt), updatedAt: validTime(record.updatedAt), versions };
      if (record.originalNumber !== undefined) {
        if (typeof record.originalNumber !== "string" || !/^\d{8}-\d{3,8}$/.test(record.originalNumber)) fail("備份中的原始編號不正確");
        normalized.originalNumber = record.originalNumber;
      }
      return normalized;
    });
    unique(records.map(record => record.id), "黏存單識別碼");
    return { format: FORMAT, schemaVersion: 3, exportedAt: validTime(value.exportedAt), records };
  }

  function request(operation) {
    return new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error || new Error("紀錄讀寫失敗"));
    });
  }

  class RecordStore {
    constructor(name = "voucher-print-records-v1") { this.name = name; this.opening = null; }
    open() {
      if (this.opening) return this.opening;
      this.opening = new Promise((resolve, reject) => {
        if (!root.indexedDB) { reject(new Error("此瀏覽器無法使用本機紀錄庫")); return; }
        const operation = root.indexedDB.open(this.name, 1);
        let settled = false;
        operation.onupgradeneeded = () => {
          operation.result.createObjectStore("records", { keyPath: "id" });
          operation.result.createObjectStore("meta", { keyPath: "key" });
        };
        operation.onsuccess = () => {
          const db = operation.result;
          if (settled) { db.close(); return; }
          settled = true;
          db.onversionchange = () => { db.close(); this.opening = null; };
          resolve(db);
        };
        operation.onerror = () => { settled = true; reject(operation.error || new Error("無法開啟紀錄庫")); };
        operation.onblocked = () => { settled = true; reject(new Error("請關閉其他黏存單分頁後，再重新整理")); };
      }).catch(error => { this.opening = null; throw error; });
      return this.opening;
    }
    async transaction(mode, work) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(["records", "meta"], mode);
        let value, error;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(error || tx.error || new Error("紀錄儲存未完成"));
        Promise.resolve().then(() => work(tx.objectStore("records"), tx.objectStore("meta"))).then(result => { value = result; }).catch(reason => {
          error = reason;
          try { tx.abort(); } catch { reject(reason); }
        });
      });
    }
    list() { return this.transaction("readonly", records => request(records.getAll())); }
    get(id) { return this.transaction("readonly", records => request(records.get(id))); }
    save(snapshot, reference = null, printRequested = false) {
      const normalized = normalizeSnapshot(snapshot);
      return this.transaction("readwrite", async (records, meta) => {
        let record = reference ? await request(records.get(reference.id)) : null;
        if (reference && !record) fail("原紀錄已不存在；請按「新增黏存單」後另存這份內容");
        const now = time();
        if (!record) {
          const stamp = dayStamp(new Date(now));
          const key = `serial:${stamp}`;
          const serial = (await request(meta.get(key)))?.value || 0;
          await request(meta.put({ key, value: serial + 1 }));
          record = { id: uid(), number: `${stamp}-${String(serial + 1).padStart(3, "0")}`, createdAt: now, updatedAt: now, versions: [] };
        }
        const expected = fingerprint(normalized);
        let version = record.versions.find(v => v.id === reference?.versionId && fingerprint(v.snapshot) === expected);
        const latest = record.versions.at(-1);
        if (!version && latest && fingerprint(latest.snapshot) === expected) version = latest;
        if (!version) {
          version = { id: uid(), number: (latest?.number || 0) + 1, savedAt: now, snapshot: copy(normalized), printEvents: [] };
          record.versions.push(version);
          record.updatedAt = now;
        }
        if (printRequested) {
          version.printEvents.push({ id: uid(), requestedAt: now, confirmedAt: null });
          record.updatedAt = now;
        }
        await request(records.put(record));
        return { record, version };
      });
    }
    confirmPrint(id, versionId, eventId) {
      return this.transaction("readwrite", async records => {
        const record = await request(records.get(id));
        const version = record?.versions.find(v => v.id === versionId);
        const event = version?.printEvents.find(e => e.id === eventId);
        if (!event) fail("找不到這次列印紀錄，請重新開啟紀錄庫");
        if (!event.confirmedAt) { event.confirmedAt = time(); record.updatedAt = event.confirmedAt; }
        await request(records.put(record));
        return record;
      });
    }
    remove(id) { return this.transaction("readwrite", records => request(records.delete(id))); }
    exportBackup() {
      return this.transaction("readonly", async records => ({ format: FORMAT, schemaVersion: 3, exportedAt: time(), records: await request(records.getAll()) }));
    }
    noteExport(exportedAt) { return this.transaction("readwrite", (records, meta) => request(meta.put({ key: "lastExport", value: exportedAt }))); }
    lastExport() { return this.transaction("readonly", (records, meta) => request(meta.get("lastExport")).then(value => value?.value || null)); }
    importBackup(input) {
      const backup = validateBackup(input);
      return this.transaction("readwrite", async (records, meta) => {
        const existing = await request(records.getAll());
        const byId = new Map(existing.map(record => [record.id, record]));
        const numbers = new Set(existing.map(record => record.number));
        const counters = new Map();
        for (const record of existing.concat(backup.records)) {
          const [stamp, serial] = record.number.split("-");
          counters.set(stamp, Math.max(counters.get(stamp) || 0, Number(serial)));
        }
        const stats = { added: 0, merged: 0, skipped: 0, renumbered: 0 };
        for (const incoming of backup.records) {
          const current = byId.get(incoming.id);
          let record;
          if (current) {
            const before = JSON.stringify(current);
            record = current;
            if (record.createdAt !== incoming.createdAt) fail("同一黏存單的建立時間不一致，已停止匯入");
            for (const incomingVersion of incoming.versions) {
              const version = record.versions.find(v => v.id === incomingVersion.id);
              if (version) {
                if (fingerprint(version.snapshot) !== fingerprint(incomingVersion.snapshot) || version.savedAt !== incomingVersion.savedAt) fail("同一版本的內容不一致，已停止匯入，原有紀錄未變更");
                for (const incomingEvent of incomingVersion.printEvents) {
                  const event = version.printEvents.find(e => e.id === incomingEvent.id);
                  if (!event) version.printEvents.push(copy(incomingEvent));
                  else {
                    if (event.requestedAt !== incomingEvent.requestedAt) fail("列印紀錄時間不一致，已停止匯入");
                    if (incomingEvent.confirmedAt && (!event.confirmedAt || incomingEvent.confirmedAt > event.confirmedAt)) event.confirmedAt = incomingEvent.confirmedAt;
                  }
                }
                version.printEvents.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
              } else {
                const next = copy(incomingVersion);
                next.number = record.versions.at(-1).number + 1;
                record.versions.push(next);
              }
            }
            record.updatedAt = [record.updatedAt, incoming.updatedAt].sort().at(-1);
            if (JSON.stringify(record) === before) { stats.skipped++; continue; }
            stats.merged++;
          } else {
            record = copy(incoming);
            if (numbers.has(record.number)) {
              const stamp = record.number.split("-")[0];
              record.originalNumber = record.originalNumber || record.number;
              counters.set(stamp, (counters.get(stamp) || 0) + 1);
              record.number = `${stamp}-${String(counters.get(stamp)).padStart(3, "0")}`;
              stats.renumbered++;
            }
            numbers.add(record.number);
            byId.set(record.id, record);
            stats.added++;
          }
          await request(records.put(record));
        }
        for (const [stamp, serial] of counters) {
          const key = `serial:${stamp}`;
          const previous = (await request(meta.get(key)))?.value || 0;
          await request(meta.put({ key, value: Math.max(previous, serial) }));
        }
        return stats;
      });
    }
  }

  const api = { RecordStore, normalizeSnapshot, fingerprint, validateBackup, dayStamp, CHECK_FIELDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoucherRecords = api;
})(typeof window !== "undefined" ? window : globalThis);
