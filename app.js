/* V192.5: единственный канонический адрес портала — https://neyroplan.ru.
   Зеркало GitHub Pages отдаёт только редирект, чтобы пользователь не работал
   на устаревшей сборке (боевой бэкенд — self-hosted Hostkey, не Render). */
(function () {
  var host = String((window.location && window.location.hostname) || "").toLowerCase();
  var isLegacyPages = /(^|\.)github\.io$/.test(host);
  if (!isLegacyPages) return;
  window.location.replace(
    "https://neyroplan.ru" + window.location.pathname + window.location.search + window.location.hash
  );
})();

/* V192.0 (ТЗ §1.4): SPA портала neyroplan.ru — без сборки, чистый JS.
   Публичная главная · кабинет подрядчика после QR-входа · защищённый /admin (MFA). */
(function () {
  "use strict";

  var CFG = window.NEYROPLAN_CONFIG || {};
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // V194.8 (ТЗ §2): публичная ссылка на Android-сборку.
  // Файл лежит в бакете releases self-hosted Supabase; обновляется при релизе APK.
  var APK_DOWNLOAD_URL = "https://db.neyroplan.ru/storage/v1/object/public/releases/neyroplan-latest.apk";
  var APK_HINT_TEXT = "Версия для Android · iOS выйдет позднее";

  var state = {
    profile: null,
    userId: null,
    userEmail: "",
    orgName: "",
    orgId: 0,
    isSuper: false,
    demoMode: "osno_22",
    qrTimer: null,
    qrUnsub: null,
    calcJobId: null,
    calcParams: {},
    calcJob: null,
    // V193.9: список расчётов (Master-Detail) и активная вкладка результата.
    calcJobs: [],
    calcTab: "volumes",
    // V193.10: объекты организации и активный объект (пилюля-переключатель).
    projects: [],
    // V194.5.5-C: причина, по которой список объектов пуст (ошибка запроса),
    // показывается прямо в блоке объектов — «тихого» нуля больше нет.
    projectsError: "",
    activeProjectId: 0,
    calcTomes: [],
    selectedTomes: {},
    calcProjects: [],
    // V194.5.5-B2: счётчики непрочитанных (чат/Биржа) и кэш смены КС-6а.
    chatUnread: 0,
    chatUnreadAt: 0,
    marketUnread: 0,
    marketUnreadAt: 0,
    shiftStages: [],
    shiftWorks: [],
    shiftStageId: "",
    // V192.6: админка открывается только после подтверждения (QR или пароль) на 30 минут.
    adminVerifiedUntil: 0,
    adminVerify: { token: "", timer: null, expiresAt: 0 },
    // V194.6.3 (доп.): сессия есть, но регистрация не завершена (пароль не задан).
    pendingReg: false,
    // V194.6.3b: user_metadata (ФИО руководителя для шапки до чтения профиля).
    userMeta: {},
    // V192.2 (ТЗ §1): наблюдение за веб-сессией для мгновенного отзыва с телефона.
    sessionWatch: { channel: null, timer: null, token: "", sessionId: "" },
    sessionTerminating: false,
  };

  // V192.6: окно подтверждённого доступа суперадминистра и ключ его следа.
  var ADMIN_VERIFY_WINDOW_MS = 30 * 60 * 1000;
  var ADMIN_VERIFY_KEY = "neuroplan.admin.verified_until";

  // Ключ локального следа веб-сессии (token + id строки web_qr_sessions).
  var WEB_SESSION_KEY = "neuroplan.web.session";
  var WEB_SESSION_POLL_MS = 20000;

  var TAX_MODES = {
    osno_22: { title: "ОСНО (НДС 22%)", vat: 22, revenue: 0, profitTaxed: false },
    usn_6: { title: "УСН 6% (доходы)", vat: 0, revenue: 6, profitTaxed: false },
    usn_15: { title: "УСН 15% (доходы минус расходы)", vat: 0, revenue: 15, profitTaxed: true },
    none: { title: "Без налога", vat: 0, revenue: 0, profitTaxed: false },
  };

  // ─────────────────────────── Хелперы ───────────────────────────
  /// Подпись роли пользователя: владелец платформы, руководитель, прораб и т.д.
  /// Владелец никогда не подписывается как «Гость».
  function roleTitleJs() {
    if (state.isSuper) return "Владелец платформы";
    var raw = String((state.profile && (state.profile.role || state.profile.title)) || "").trim();
    var map = {
      DIRECTOR: "Руководитель", OWNER: "Руководитель", MANAGER: "Менеджер",
      FOREMAN: "Прораб", BRIGADIER: "Бригадир", ESTIMATOR: "Сметчик",
      SUPPLY: "Снабжение", ACCOUNTANT: "Бухгалтер", ENGINEER: "Инженер ПТО",
      PTO: "Инженер ПТО", GUEST: "Гость", ADMIN: "Администратор",
    };
    var code = raw.toUpperCase();
    return map[code] || raw || "Сотрудник";
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function num(value) {
    if (typeof value === "number") return value;
    var parsed = parseFloat(String(value == null ? "" : value).replace(/\s/g, "").replace(",", "."));
    return isNaN(parsed) ? 0 : parsed;
  }
  function round2(value) { return Math.round(num(value) * 100) / 100; }
  function money(value) {
    var v = round2(value);
    var parts = v.toFixed(2).split(".");
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return intPart + "," + parts[1] + " ₽";
  }
  function qty(value) { return num(value).toFixed(2); }
  function pct(value) { return round2(value).toFixed(2) + "%"; }

  /// V194.5.5-C (ТЗ §1.2): маржа сметы в процентах.
  /// Формула ТЗ: ((Смета − Рынок) / Смета) × 100. Деление на ноль и пустые
  /// значения (null/undefined/«») дают 0.00% — исключения не бросаются,
  /// таблица «Сметы» больше не падает с `jobMarginPercent is not defined`.
  function jobMarginPercent(job) {
    if (!job) return 0;
    var contract = num(job.contract_total);
    var market = num(job.market_total);
    if (!(contract > 0)) return 0;
    return ((contract - market) / contract) * 100;
  }

  function toast(message, ms) {
    var node = $("#toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { node.classList.add("hidden"); }, ms || 3200);
  }

  /// V194.6.2 (ТЗ §1–§4): модалка получает размерный класс
  /// (`doc` 920px, `wide` 1100px, `tariffs` 1240px). Базовый вызов без размера
  /// сохраняет прежнюю ширину 560px.
  function openModal(title, html, size) {
    var modal = $("#modal");
    if (modal) {
      modal.className = "modal" + (size ? " modal--" + size : "");
      if (size === "doc") modal.setAttribute("data-print-root", "1");
      else modal.removeAttribute("data-print-root");
    }
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-backdrop").classList.remove("hidden");
  }
  /// V194.6.3 (доп.): `force` нужен только внутренним сценариям (сохранение пароля,
  /// выход из аккаунта) — пока регистрация не завершена, окно закрыть нельзя.
  function closeModal(force) {
    // Строгая проверка: обработчики клика передают объект события, он не «force».
    if (force !== true && state.reg && state.reg.locked) {
      toast("Сначала задайте пароль — регистрация не завершена", 7000);
      return;
    }
    $("#modal-backdrop").classList.add("hidden");
    $("#modal-body").innerHTML = "";
    // V194.6.3: обратный отсчёт повторной отправки кода не живёт после закрытия окна.
    if (state.reg && state.reg.otpTimer) {
      clearInterval(state.reg.otpTimer);
      state.reg.otpTimer = null;
    }
    if (state.qrTimer) { clearInterval(state.qrTimer); state.qrTimer = null; }
    if (state.qrUnsub) { try { state.qrUnsub.unsubscribe(); } catch (e) {} state.qrUnsub = null; }
    // V192.6: опрос админского QR-челленджа не должен жить после закрытия окна.
    if (state.adminVerify && state.adminVerify.timer) {
      clearInterval(state.adminVerify.timer);
      state.adminVerify.timer = null;
    }
  }

  function pill(text, kind) {
    return '<span class="pill pill-' + (kind || "navy") + '">' + esc(text) + "</span>";
  }

  async function invokeQr(body) {
    try {
      var res = await sb.functions.invoke(CFG.qrFunction || "qr-auth", { body: body });
      return res.data || { ok: false, error: "empty_response" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "edge_unavailable" };
    }
  }

  async function loadProfile() {
    var session = (await sb.auth.getSession()).data.session;
    if (!session) {
      state.userId = null;
      state.userEmail = "";
      state.profile = null;
      state.isSuper = false;
      state.orgName = "";
      state.pendingReg = false;
      state.userMeta = {};
      state.legalV2 = null;
      return null;
    }
    state.userId = session.user.id;
    state.userEmail = String((session.user && session.user.email) || "");
    // V194.6.3 (доп.): незавершённая регистрация по флагам user_metadata.
    // Пока пароль не задан, заглушку «Компания …» в шапке не показываем.
    var sessionMeta = (session.user && session.user.user_metadata) || {};
    state.userMeta = sessionMeta;
    state.pendingReg = isPendingRegistrationMeta(sessionMeta);
    var res = await sb.from("profiles")
      .select("id, full_name, role, organization_id, is_superadmin, email, account_type")
      .eq("id", session.user.id).maybeSingle();
    // V194.5.5-C2: сбой чтения профиля больше не маскируется «Демо-режимом» молча.
    if (res.error) console.warn("[profiles] профиль не прочитан:", res.error.message);
    state.profile = res.data || null;
    state.orgId = num(res.data && res.data.organization_id);
    // V192.6: владелец платформы — строго по profiles (is_superadmin или role=superadmin).
    var roleCode = String((res.data && res.data.role) || "").trim().toLowerCase();
    state.isSuper = !!(
      (res.data && (res.data.is_superadmin === true || res.data.is_superadmin === 1)) ||
      roleCode === "superadmin" || roleCode === "суперадмин"
    );
    if (res.data && res.data.email) state.userEmail = String(res.data.email);
    state.orgName = state.pendingReg ? "" : await loadOrganizationName(state.orgId);
    // V194.5.5-B2: в public.profiles есть только last_seen_at — колонка
    // last_login_at отсутствует, из-за неё PATCH возвращал 400 на каждой
    // загрузке сессии. Пишем один last_seen_at и не чаще раза в 10 минут.
    try {
      var seenKey = "np_last_seen_ping";
      var lastPing = 0;
      try { lastPing = Number(localStorage.getItem(seenKey) || 0) || 0; } catch (e) {}
      if (Date.now() - lastPing > 10 * 60 * 1000) {
        var stamp = new Date().toISOString();
        var touch = await sb.from("profiles")
          .update({ last_seen_at: stamp })
          .eq("id", session.user.id);
        if (touch.error) {
          console.warn("[profiles] last_seen_at не обновлён:", touch.error.message);
        } else {
          try { localStorage.setItem(seenKey, String(Date.now())); } catch (e) {}
        }
      }
    } catch (e) { /* не критично для входа */ }
    return state.profile;
  }

  /// V192.6: название компании для шапки портала (кэшируется в state.orgName).
  async function loadOrganizationName(orgId) {
    if (!orgId) return "";
    try {
      var res = await sb.from("organizations").select("id, name").eq("id", orgId).maybeSingle();
      return String((res.data && res.data.name) || "").trim();
    } catch (e) {
      return "";
    }
  }

  /// V193.1: единый нормализатор ролей (русский/английский, без учёта регистра).
  /// V193.2: нераспознанная роль и приглашённый сотрудник — «Гость» (GUEST),
  /// но НИКОГДА DIRECTOR. Директор назначается только при создании организации.
  function normalizeRoleCode(raw) {
    var text = String(raw || "").trim().toLowerCase()
      .replace(/ё/g, "е").replace(/_/g, " ").replace(/\s+/g, " ");
    if (!text) return "GUEST";
    if (text === "superadmin" || text === "суперадмин") return "SUPERADMIN";
    if (text === "director" || text === "директор" || text === "руководитель" ||
      text === "генеральный директор" || text === "owner") return "DIRECTOR";
    if (text === "estimator" || text === "сметчик") return "ESTIMATOR";
    if (text === "supply" || text === "снабженец") return "SUPPLY";
    if (text === "accountant" || text === "бухгалтер" || text === "главбух") return "ACCOUNTANT";
    if (text === "brigadier" || text === "бригадир") return "BRIGADIER";
    if (text === "guest" || text === "гость" || text === "гость (ограниченный доступ)") return "GUEST";
    if (text === "foreman" || text === "прораб" || text === "сотрудник" ||
      text === "user" || text === "employee") return "FOREMAN";
    if (text.indexOf("суперадмин") >= 0 || text.indexOf("superadmin") >= 0) return "SUPERADMIN";
    if (text.indexOf("директор") >= 0 || text.indexOf("director") >= 0 ||
      text.indexOf("руководител") >= 0 || text.indexOf("генеральн") >= 0 ||
      text.indexOf("owner") >= 0) return "DIRECTOR";
    if (text.indexOf("сметчик") >= 0 || text.indexOf("estimator") >= 0) return "ESTIMATOR";
    if (text.indexOf("снабжен") >= 0 || text.indexOf("supply") >= 0) return "SUPPLY";
    if (text.indexOf("бухгалтер") >= 0 || text.indexOf("accountant") >= 0 ||
      text.indexOf("главбух") >= 0) return "ACCOUNTANT";
    if (text.indexOf("бригадир") >= 0 || text.indexOf("brigadier") >= 0) return "BRIGADIER";
    if (text.indexOf("гость") >= 0 || text.indexOf("guest") >= 0) return "GUEST";
    return "GUEST";
  }

  /// Человекочитаемая должность из profiles.role / project_users.role.
  function roleTitle(role) {
    if (!String(role || "").trim()) return "";
    var code = normalizeRoleCode(role);
    if (code === "SUPERADMIN") return "Владелец платформы";
    if (code === "DIRECTOR") return "Директор";
    if (code === "ESTIMATOR") return "Сметчик";
    if (code === "SUPPLY") return "Снабженец";
    if (code === "ACCOUNTANT") return "Бухгалтер";
    if (code === "BRIGADIER") return "Бригадир";
    if (code === "GUEST") return "Гость";
    return "Сотрудник / Прораб";
  }

  // ═════════ V194.5.5-B2: бейдж непрочитанных «Штаба · Чат» ═════════
  var CHAT_READ_KEY = "np_chat_read_at";

  function chatReadAt() {
    try { return String(localStorage.getItem(CHAT_READ_KEY) || ""); } catch (e) { return ""; }
  }

  function markChatRead() {
    try { localStorage.setItem(CHAT_READ_KEY, new Date().toISOString()); } catch (e) {}
    updateChatBadge(0);
  }

  function updateChatBadge(count) {
    state.chatUnread = Math.max(0, num(count));
    var node = $("#nav-chat-count");
    if (!node) return;
    if (state.chatUnread > 0) {
      node.textContent = state.chatUnread > 99 ? "99+" : String(state.chatUnread);
      node.classList.remove("hidden");
    } else {
      node.textContent = "0";
      node.classList.add("hidden");
    }
  }

  /// Счётчик непрочитанных по организации (не чаще 15 секунд, без падений).
  async function refreshChatUnread() {
    if (!state.userId || !state.orgId) { updateChatBadge(0); return 0; }
    if (Date.now() - num(state.chatUnreadAt) < 15000) return state.chatUnread;
    state.chatUnreadAt = Date.now();
    try {
      var since = chatReadAt();
      var query = sb.from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", state.orgId);
      if (since) query = query.gt("timestamp", since);
      var res = await query;
      if (res && !res.error) updateChatBadge(num(res.count));
    } catch (e) { /* бейдж не должен ломать портал */ }
    return state.chatUnread;
  }

  function renderSessionBadge() {
    var badge = $("#session-badge");
    var nameNode = $("#session-name");
    var metaNode = $("#session-meta");
    var login = $("#btn-login");
    var logout = $("#btn-logout");
    var adminLink = $("#nav-admin");
    if (state.userId) {
      // V194.5.5-B2: любой сбой бейджа не должен ломать инициализацию и роутер.
      try {
        if (typeof refreshChatUnread === "function") refreshChatUnread();
        if (typeof refreshMarketplaceUnread === "function") refreshMarketplaceUnread();
      } catch (badgeError) {
        console.warn("[badges]", badgeError);
      }
      // V194.6.3b: в шапке — ФИО, а не e-mail. Приоритет:
      // профиль → user_metadata → e-mail → «Подрядчик».
      var meta = state.userMeta || {};
      var profile = state.profile || {};
      var fullName = String(
        profile.full_name || profile.director_name ||
        meta.full_name || meta.director_name ||
        state.userEmail || "Подрядчик"
      ).trim() || "Подрядчик";
      var roleLabel = roleTitle(state.profile && state.profile.role);
      var orgLabel = state.pendingReg
        ? "Регистрация не завершена"
        : (state.orgName || (state.isSuper ? "Владелец платформы" : "Организация"));
      if (nameNode) nameNode.textContent = fullName;
      if (metaNode) metaNode.textContent = [orgLabel, roleLabel].filter(Boolean).join(" · ");
      // Почта — только во всплывающей подсказке, текстом её не дублируем.
      if (badge) {
        if (state.userEmail) badge.setAttribute("title", state.userEmail);
        else badge.removeAttribute("title");
        badge.classList.remove("hidden");
      }
      if (login) login.classList.add("hidden");
      if (logout) logout.classList.remove("hidden");
    } else {
      if (badge) {
        badge.classList.add("hidden");
        badge.removeAttribute("title");
      }
      if (login) login.classList.remove("hidden");
      if (logout) logout.classList.add("hidden");
      if (nameNode) nameNode.textContent = "";
      if (metaNode) metaNode.textContent = "";
    }
    var registerBtn = $("#btn-register");
    if (registerBtn) {
      if (state.userId) registerBtn.classList.add("hidden");
      else registerBtn.classList.remove("hidden");
    }
    var projectLink = $("#nav-project");
    if (projectLink) {
      if (canUseProjectCalc()) projectLink.classList.remove("hidden");
      else projectLink.classList.add("hidden");
    }
    // V192.6: вкладка «Админ» видна ТОЛЬКО владельцу платформы.
    if (adminLink) {
      var showAdmin = !!state.userId && state.isSuper;
      adminLink.classList.toggle("is-visible", showAdmin);
      if (showAdmin) adminLink.removeAttribute("hidden");
      else adminLink.setAttribute("hidden", "hidden");
    }
  }

  // ─────────────────── Коммерческий калькулятор (единый с воркером) ───────────────────
  function computeCommercial(costModel, params, areaM2) {
    var p = Object.assign({
      materials_percent: 0, tooling_percent: 0, travel_rub: 0,
      travel_people: 0, travel_days: 0, travel_per_person_day: 0,
      overhead_percent: 0, profit_percent: 0, tax_mode: "none",
    }, params || {});
    var mode = TAX_MODES[p.tax_mode] || TAX_MODES.none;
    var totals = (costModel && costModel.totals) || {};
    var costTotal = num(totals.total_cost);
    var materials = num(totals.materials);
    var materialsMarkup = round2(materials * num(p.materials_percent) / 100);
    var tooling = round2(costTotal * num(p.tooling_percent) / 100);
    var travel = num(p.travel_rub);
    if (travel <= 0) {
      travel = round2(num(p.travel_people) * num(p.travel_days) * num(p.travel_per_person_day));
    }
    var subtotal = round2(costTotal + materialsMarkup + tooling + travel);
    var overhead = round2(subtotal * num(p.overhead_percent) / 100);
    var prime = round2(subtotal + overhead);
    var profit = round2(prime * num(p.profit_percent) / 100);
    var base = round2(prime + profit);
    var vat = round2(base * mode.vat / 100);
    var taxable = base - prime;
    var revenueTax = mode.profitTaxed
      ? round2(Math.max(0, taxable) * mode.revenue / 100)
      : round2(base * mode.revenue / 100);
    var total = round2(base + vat);
    var area = num(areaM2);
    return {
      params: p, taxTitle: mode.title, vatPercent: mode.vat,
      costTotal: costTotal, materialsMarkup: materialsMarkup, tooling: tooling,
      travel: travel, subtotal: subtotal, overhead: overhead, prime: prime,
      profit: profit, base: base, vat: vat, revenueTax: revenueTax, total: total,
      area: area, pricePerM2: area > 0 ? round2(total / area) : 0,
      costPerM2: area > 0 ? round2(costTotal / area) : 0,
    };
  }

  // Демонстрационные примеры разбора для главной страницы (переключение налогов).
  var DEMO = {
    title: "ЖК «Северный», корпус 3 · 9 этажей · 6 400 м²",
    cost: 61_450_000,
    materials: 34_200_000,
    works: 19_800_000,
    machinery: 4_950_000,
    services: 2_500_000,
  };

  function renderDemo(container) {
    var result = computeCommercial(
      { totals: { total_cost: DEMO.cost, materials: DEMO.materials, works: DEMO.works, machinery: DEMO.machinery, services: DEMO.services } },
      { materials_percent: 7, tooling_percent: 2.5, travel_rub: 250000, overhead_percent: 12, profit_percent: 10, tax_mode: state.demoMode },
      DEMO.cost > 0 ? 6400 : 0
    );
    container.innerHTML =
      '<div class="flex-between"><h3 style="margin:0;font-size:15px;">' + esc(DEMO.title) + "</h3>" +
      pill(result.taxTitle, "navy") + "</div>" +
      '<div class="tax-switch mt-8">' +
      Object.keys(TAX_MODES).map(function (key) {
        return '<button data-tax="' + key + '" class="' + (state.demoMode === key ? "active" : "") + '">' +
          esc(TAX_MODES[key].title) + "</button>";
      }).join("") + "</div>" +
      '<div class="grid grid-4">' +
      kpi("Себестоимость без НДС", money(result.costTotal), "материалы/работы/техника") +
      kpi("Полная себестоимость", money(result.prime), "с накладными расходами") +
      kpi("НДС / налог по режиму", money(result.vat || result.revenueTax), result.taxTitle) +
      kpi("Предложение заказчику", money(result.total), pct(result.pricePerM2 ? 100 : 0).replace("100.00%", "") + qty(result.pricePerM2) + " ₽ / 1 м²") +
      "</div>" +
      '<div class="table-wrap mt-16"><table class="data"><thead><tr><th>Показатель</th><th class="num">Сумма</th></tr></thead><tbody>' +
      demoRow("Прямые затраты (материалы + работы + техника + общеплощадочные)", result.costTotal) +
      demoRow("Расходные материалы, наценка 7%", result.materialsMarkup) +
      demoRow("Инструмент и логистика, 2,5%", result.tooling) +
      demoRow("Командировочные", result.travel) +
      demoRow("Накладные расходы, 12%", result.overhead) +
      demoRow("Полная себестоимость", result.prime) +
      demoRow("Плановая прибыль ГП, 10%", result.profit) +
      demoRow("База без НДС", result.base) +
      demoRow("НДС (" + result.vatPercent + "%)", result.vat) +
      '<tr class="row-stage"><td>ИТОГО предложение заказчику</td><td class="num">' + money(result.total) + "</td></tr>" +
      '<tr class="row-stage"><td>Стоимость 1 м²</td><td class="num">' + money(result.pricePerM2) + "</td></tr>" +
      "</tbody></table></div>";

    $all("[data-tax]", container).forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.demoMode = btn.getAttribute("data-tax");
        renderDemo(container);
      });
    });
  }

  function demoRow(label, value) {
    return "<tr><td>" + esc(label) + '</td><td class="num">' + money(value) + "</td></tr>";
  }
  function kpi(label, value, note) {
    return '<div class="card kpi"><span class="kpi-label">' + esc(label) + "</span>" +
      '<span class="kpi-value">' + esc(value) + "</span>" +
      '<span class="kpi-note">' + esc(note || "") + "</span></div>";
  }

  // ─────────────────────────── Витрина тарифов ───────────────────────────
  // V194.6.0 (ТЗ §6): чистая B2B-витрина без служебных подписей.
  function rubText(value) {
    return String(Math.round(num(value))).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
  }

  // ═════════════ V194.6.5: акция «−30% до 31.12.2026» на витрине тарифов ═════════════
  // Перечень и лимиты тарифов остаются в TARIFF_MATRIX (источник истины —
  // public.tariff_plans). Здесь только витрина акции: перечёркнутая базовая
  // цена и округлённая цена по акции для трёх карточек.
  var TARIFF_PROMO_TITLE = "Акция −30% до 31.12.2026";
  var TARIFF_PROMO = {
    start: { title: "Старт", base: 1990, promo: 1390 },
    // В акции карточка среднего тарифа подписана «Прораб» (код small_business).
    small_business: { title: "Прораб", base: 4490, promo: 3140 },
    general_contractor: { title: "Генподрядчик", base: 8990, promo: 6290 },
  };
  // V194.6.5: витрина в режиме открытого тестирования — онлайн-оплаты пока нет.
  var PRICING_TEST_NOTE = "Сайт работает в режиме открытого тестирования: онлайн-оплата " +
    "тарифов временно недоступна, весь функционал доступен, а дополнительные лимиты " +
    "предоставляются бесплатно по запросу разработчику.";

  /// V194.6.1 (ТЗ §1): сетка тарифов больше не выводится в потоке главной —
  /// её открывает верхняя кнопка «Тарифы» (модальное окно `openTariffsModal`).
  function pricingLimitText(value, perMonth) {
    if (value < 0) return "Безлимит";
    return value + (perMonth ? " / мес" : "");
  }

  function pricingCardHtml(plan, yearly) {
    var promo = TARIFF_PROMO[plan.code] || null;
    var cardTitle = (promo && promo.title) || plan.title;
    var rows = [
      ["Объекты", pricingLimitText(plan.objects, false)],
      ["Сотрудники", pricingLimitText(plan.employees, false)],
      ["ИИ-разбор смет", pricingLimitText(plan.estimates, true)],
      ["ИИ-расчёт ПД/РД", pricingLimitText(plan.pd, true)],
      ["Чат ИИ-ПТО", plan.chatUnlimited ? "Безлимит" : pricingLimitText(plan.chat, true)],
      ["Сканер чеков", pricingLimitText(plan.ocr, true)],
      ["ИИ-юрист (проверка договоров)", pricingLimitText(plan.legal, true)],
      ["Биржа подрядов", plan.marketplace < 0
        ? "Безлимит + закрепление"
        : pricingLimitText(plan.marketplace, true)],
      ["Видеокамеры на объект", plan.cameras ? String(plan.cameras) : "—"],
      ["Хранилище", plan.storageGb + " ГБ"],
      ["Операционные модули", "ГПР, рабочая смета, КС-2/КС-3, АОСР"],
    ];
    var priceHtml;
    if (promo && !yearly) {
      priceHtml = '<div class="pricing-promo">' + esc(TARIFF_PROMO_TITLE) + "</div>" +
        '<div class="pricing-price pricing-price--promo">' +
        "<s>" + rubText(promo.base) + "</s> " + rubText(promo.promo) + "<span>/мес</span></div>" +
        '<div class="pricing-year">Цена по акции при оплате за месяц</div>';
    } else if (yearly) {
      priceHtml = '<div class="pricing-price">' + rubText(plan.yearlyMonthly) +
        "<span>/мес</span></div>" +
        '<div class="pricing-year">' + rubText(plan.yearlyTotal) + " за год</div>";
    } else {
      priceHtml = '<div class="pricing-price">' + rubText(plan.price) + "<span>/мес</span></div>" +
        '<div class="pricing-year">при оплате за месяц</div>';
    }
    return '<div class="pricing-card' + (plan.code === "general_contractor" ? " pricing-card--hot" : "") + '">' +
      (plan.code === "general_contractor"
        ? '<div class="pricing-badge">Популярный</div>' : "") +
      "<h3>" + esc(cardTitle) + "</h3>" +
      '<div class="pricing-audience">' + esc(plan.audience) + "</div>" +
      priceHtml +
      '<ul class="pricing-list">' +
      rows.map(function (row) {
        return "<li><span>" + esc(row[0]) + "</span><strong>" + esc(row[1]) + "</strong></li>";
      }).join("") +
      (plan.customDev
        ? '<li class="pricing-special">Готовы разработать дополнительный функционал под ' +
          "задачи вашей компании при наличии технической возможности (включая интеграции " +
          "с 1С и банковскими сервисами)</li>"
        : "") +
      "</ul>" +
      '<button class="btn btn-navy pricing-choose" type="button" data-tariff-choose="' +
      esc(plan.code) + '">Начать бесплатное тестирование</button>' +
      '<button class="btn btn-outline btn-sm pricing-limits" type="button" ' +
      'data-pricing-limits="' + esc(plan.code) + '">Запросить дополнительные лимиты</button>' +
      "</div>";
  }

  function renderPricingGrid(period) {
    var grid = $("#pricing-grid");
    if (!grid) return;
    var yearly = period === "yearly";
    grid.innerHTML = kPaidPlans().map(function (plan) {
      return pricingCardHtml(plan, yearly);
    }).join("");
    $all("[data-tariff-choose]", grid).forEach(function (btn) {
      btn.addEventListener("click", function () {
        // V194.6.5: онлайн-оплаты нет — кнопка ведёт на бесплатную регистрацию.
        openRegistration("company_owner", "", btn.getAttribute("data-tariff-choose"));
      });
    });
    $all("[data-pricing-limits]", grid).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openFeedbackModal("support");
      });
    });
  }

  function kPaidPlans() {
    return TARIFF_MATRIX.filter(function (plan) {
      return plan.code !== "trial";
    });
  }

  function bindPricing(root) {
    renderPricingGrid("monthly");
    $all("[data-pricing-period]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        $all("[data-pricing-period]", root).forEach(function (node) {
          node.classList.toggle("active", node === btn);
        });
        renderPricingGrid(btn.getAttribute("data-pricing-period"));
      });
    });
  }


  // ─────────────────────────── Публичная главная ───────────────────────────
  function renderLanding(root) {
    root.innerHTML =
      '<section class="hero hero-arch">' +
      '<div class="hero-arch-bg" aria-hidden="true"></div>' +
      '<div class="hero-inner notranslate">' +
      '<div class="hero-badge">ИИ-ПЛАТФОРМА ФИНАНСОВО-ИНЖЕНЕРНОГО АУДИТА СТРОЙКИ</div>' +
      "<h1>НейроПлан — ИИ-аудит смет, расчёт объектов по ПД/РД<br>и контроль прибыли стройки</h1>" +
      "<p>Одна платформа вместо ручной сверки: загрузите смету или тома проекта — получите чистые физические объёмы, " +
      "себестоимость по конструктивам, коммерческое предложение заказчику и финансовую модель объекта. " +
      "Все цифры сходятся до копейки между телефоном, кабинетом и Excel.</p>" +
      '<div class="hero-actions">' +
      '<button class="btn btn-primary" id="hero-try" type="button">Попробовать бесплатно →</button>' +
      // V194.8 (ТЗ §2): заметная кнопка Android-сборки прямо в главном блоке.
      '<a class="btn btn-navy apk-download-btn" id="hero-apk" href="' + APK_DOWNLOAD_URL + '"' +
      ' target="_blank" rel="noopener" download>' +
      '<span class="apk-download-icon" aria-hidden="true">⬇</span>' +
      '<span class="apk-download-label">Скачать для Android (APK)</span></a>' +
      '<button class="btn btn-ghost" id="hero-tariffs" type="button">Тарифы и подписка</button>' +
      '<button class="btn btn-ghost" id="hero-partners" type="button">Для партнёров</button>' +
      "</div>" +
      '<div class="apk-hint">' + esc(APK_HINT_TEXT) + "</div>" +
      '<div class="hero-notes notranslate">' +
      '<span class="hero-note">Контур А · смета до копейки</span>' +
      '<span class="hero-note">ПД/РД · ведомость объёмов</span>' +
      '<span class="hero-note">КП и финансовая модель в 1 клик</span>' +
      "</div></div></section>" +
      testingBannerHtml() +

      '<section class="section"><h2 class="section-title">НейроПлан в сравнении с классическими системами управления предприятием</h2>' +
      '<p class="section-sub">Сравнение по тем операциям, которые съедают время сметчика и руководителя.</p>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th>Операция</th>' +
      "<th>Классическая ручная ERP</th><th>НейроПлан</th></tr></thead><tbody>" +
      compareRow("Разбор сметы .xlsx / .gsfx", "Ручной ввод позиций, 4–8 часов", "Контур А и Контур Б автоматически, минуты") +
      compareRow("Расчёт объекта по ПД/РД", "Отдельный сметчик на 2–3 недели", "Параллельный разбор томов КЖ, АР, КМ, ОВ, ВК, ЭОМ + синтез механизации") +
      compareRow("Цены материалов", "Прайсы поставщиков вручную", "База расценок компании + региональный хаб + второе мнение ИИ") +
      compareRow("Коммерческое предложение", "Excel-шаблон и ручные наценки", "Калькулятор КП: % и ₽, моментальный пересчёт и ₽/1 м²") +
      compareRow("Выходные документы", "Сборка вручную", "Финансовая модель для директора + КП (.xlsx и .docx) в 1 клик") +
      "</tbody></table></div></section>" +

      '<section class="section"><h2 class="section-title">Модули платформы — посмотрите в действии</h2>' +
      '<p class="section-sub">Кликните на карточку: короткое демо работы модуля, без регистрации.</p>' +
      '<div class="showcase-grid mt-16">' +
      MODULE_SHOWCASE.map(function (item) {
        return '<button class="showcase-card" data-showcase="' + esc(item.key) + '" type="button">' +
          '<div class="sc-icon">' + item.icon + "</div>" +
          '<div class="sc-title">' + esc(item.title) + "</div>" +
          '<div class="sc-desc">' + esc(item.desc) + "</div></button>";
      }).join("") + "</div></section>" +

      '<section class="section"><h2 class="section-title">Интерактивный пример разбора</h2>' +
      '<p class="section-sub">Переключите налоговый режим — суммы пересчитываются мгновенно, как в кабинете.</p>' +
      '<div class="card" id="demo-box"></div></section>' +

      '<section class="section"><h2 class="section-title">Преимущества для команды</h2>' +
      '<div class="grid grid-4 mt-16">' +
      roleCard("Руководитель", "Видит себестоимость, прибыль и стоимость 1 м² до подписания договора. Финансовая модель объекта в Excel на живых формулах.") +
      roleCard("Сметчик", "Правка любой цифры объёма и цены с мгновенным пересчётом. База расценок компании под рукой на большом экране.") +
      roleCard("Снабженец", "Позиции без подтверждённой цены видны сразу: что докупить, где искать и по какой ссылке.") +
      roleCard("Прораб", "Ведомость объёмов по секциям, техника и смены механизмов, общеплощадочные расходы без двойного счёта.") +
      "</div></section>" +
      // V194.6.1 (ТЗ §1): тарифная сетка и обучение вынесены из потока главной —
      // их открывают верхние кнопки «Тарифы» и «Обучение» (модальные окна).
      pricingTeaserHtml();

    renderDemo($("#demo-box"));
    var pricingTeaser = $("#pricing-teaser-open");
    if (pricingTeaser) pricingTeaser.addEventListener("click", openTariffsModal);
    // V194.6.5: плашка тестирования — переход в форму связи с разработчиком.
    var testingContact = $("#testing-contact");
    if (testingContact) testingContact.addEventListener("click", function () {
      openFeedbackModal("support");
    });
    var heroTry = $("#hero-try");
    if (heroTry) heroTry.addEventListener("click", function () { openRegistration("company_owner"); });
    var heroPartners = $("#hero-partners");
    if (heroPartners) heroPartners.addEventListener("click", function () {
      openFeedbackModal("partnership");
    });
    var heroTariffs = $("#hero-tariffs");
    if (heroTariffs) heroTariffs.addEventListener("click", openTariffsModal);
    $all("[data-showcase]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openModuleDemo(btn.getAttribute("data-showcase"));
      });
    });
  }

  /// V194.6.5: плашка «режим открытого тестирования» + перечень платформ.
  function testingBannerHtml() {
    return '<section class="section testing-banner">' +
      '<div class="testing-card">' +
      '<div class="testing-badge">РЕЖИМ ОТКРЫТОГО ТЕСТИРОВАНИЯ</div>' +
      '<p class="testing-text">Платформа работает в режиме открытого тестирования. ' +
      "Весь основной функционал доступен уже сейчас — регистрируйтесь и тестируйте бесплатно. " +
      "Онлайн-оплата тарифов будет подключена позднее. Если функционал понравился и вы хотите " +
      "продолжить тестирование — свяжитесь с разработчиком, и мы предоставим дополнительные " +
      "лимиты бесплатно. Будем рады обратной связи, вашим вопросам и предложениям по " +
      "функционалу и удобству работы.</p>" +
      '<div class="testing-actions">' +
      '<button class="btn btn-navy" id="testing-contact" type="button">' +
      "Связаться с разработчиком</button>" +
      '<span class="small muted">neyroplan@mail.ru · Telegram-канал НейроПлан</span>' +
      "</div>" +
      '<div class="platform-note">Доступно на Android и компьютере (веб-портал), ' +
      "версия для iOS выйдет позднее</div>" +
      "</div></section>";
  }

  /// V194.6.5: компактная плашка вместо тарифной сетки в потоке главной.
  /// Сама сетка живёт в модальном окне «Тарифы» (верхняя кнопка шапки).
  function pricingTeaserHtml() {
    return '<section class="section pricing-teaser">' +
      '<div class="pricing-teaser-card">' +
      '<div class="pricing-teaser-text">' +
      '<div class="pricing-teaser-title">10 дней бесплатно — попробуйте НейроПлан на реальном объекте</div>' +
      '<div class="pricing-teaser-sub">Тарифы от ' + esc(rubText(TARIFF_PROMO.start.promo)) +
      "/мес по акции −30 % до 31.12.2026. Сайт работает в режиме открытого тестирования: " +
      "онлайн-оплата будет подключена позднее, дополнительные лимиты — бесплатно " +
      "по запросу разработчику.</div>" +
      "</div>" +
      '<button class="btn btn-navy" id="pricing-teaser-open" type="button">Тарифы и подключение</button>' +
      "</div></section>";
  }

  /// V194.6.2 (ТЗ §2): модалка «Обучение» — 5 просторных карточек сценариев
  /// с inline-SVG мини-схемами интерфейса и закреплённой панелью действий.
  function openLearningModal() {
    openModal("Обучение работе в НейроПлане",
      '<p class="learn-lead">Пять практических сценариев — от загрузки сметы до актов и проверки договора. ' +
      "Каждый шаг показывает, что получит сметчик, прораб и руководитель.</p>" +
      '<div class="learn-grid">' +
      learnCard("1. Разбор сметы и сверка с расчётом по ПД/РД",
        "Загрузите смету .xlsx/.gsfx — платформа сверит прямые затраты (ФОТ + материалы + " +
        "машины + оборудование + транспорт) и покажет расхождения. Затем загрузите тома " +
        "проекта: из спецификаций соберётся ведомость объёмов с номерами листов, и вы " +
        "сравните проект с документом до подписания.", learnSvgEstimate()) +
      learnCard("2. Внедрение в ГПР и Рабочую смету",
        "Разделы сметы автоматически становятся этапами графика производства работ. " +
        "Прораб отмечает фактические объёмы, рабочая смета сразу видит остаток и перерасход, " +
        "а материалы списываются пропорционально выполненным работам.", learnSvgGpr()) +
      learnCard("3. Формирование КС-2, КС-3 и АОСР по 344/пр",
        "Отметьте выполненные объёмы — акт КС-2 и справка КС-3 соберутся в .xlsx по форме, " +
        "АОСР — по Приказу № 344/пр в .docx. Черновик можно пересобрать, а закрытые объёмы " +
        "вернутся в остаток при удалении.", learnSvgKs()) +
      learnCard("4. Проверка договора ИИ-юристом",
        "В реестре договоров нажмите «Проверить договор (ИИ-юрист)»: платформа найдёт " +
        "опечатки и ошибки в датах, расхождения суммы прописью и цифрами, перекосы " +
        "неустоек и сроков оплаты — с готовыми формулировками исправлений.", learnSvgLegal()) +
      learnCard("5. Модуль «Чертежи» и чат ИИ-ПТО",
        "Загрузите альбомы РД (АР, КЖ, КМ, ОВ, ВК, ЭОМ и другие): платформа проиндексирует " +
        "листы, спецификации и общие указания. В чате ИИ-ПТО спросите про марки, объёмы и " +
        "узлы — ответ будет со ссылкой на номер листа, а если данных нет или лист нечитаем, " +
        "помощник прямо об этом скажет.", learnSvgDrawings()) +
      "</div>" +
      '<div class="learn-bar">' +
      '<button class="btn btn-navy" id="learn-register" type="button">Попробовать бесплатно (10 дней)</button>' +
      '<button class="btn btn-outline" id="learn-tariffs" type="button">Посмотреть тарифы</button>' +
      "</div>", "wide");
    var regBtn = $("#learn-register");
    if (regBtn) regBtn.addEventListener("click", function () {
      closeModal();
      openRegistration("company_owner");
    });
    var tariffsBtn = $("#learn-tariffs");
    if (tariffsBtn) tariffsBtn.addEventListener("click", function () {
      closeModal();
      openTariffsModal();
    });
  }

  /// Витрина модулей на главной (синхронно с приложением).
  var MODULE_SHOWCASE = [
    { key: "estimate", icon: "📊", title: "Смета ИИ-Аудит",
      desc: "Разбор .xlsx/.gsfx, Контур А и Контур Б, риски и маржа" },
    { key: "calc", icon: "🏗", title: "Расчёт по ПД/РД",
      desc: "Ведомость объёмов, себестоимость и КП по томам проекта" },
    { key: "drawings", icon: "📐", title: "Чертежи ИИ-ПТО",
      desc: "Полистный аудит РД, паспорт чертежа и скрытые работы" },
    { key: "chat", icon: "💬", title: "Штаб стройки",
      desc: "Чаты по объектам и каналам, файлы и фото с площадки" },
    { key: "gpr", icon: "📅", title: "ГПР — КС-2 / КС-3",
      desc: "График производства работ и оформление актов КС-2 / КС-3" },
    { key: "finance", icon: "💰", title: "Финансы",
      desc: "Операции по объектам, счета, оплаты и субсчёт" },
    { key: "object", icon: "📷", title: "Объект + Фотоотчёт + LIVE",
      desc: "Паспорт объекта, обложка в облаке, фотоотчёт и камера" },
  ];

  var MODULE_DEMO_TEXT = {
    estimate: "<strong>Смета ИИ-Аудит.</strong> Загрузите смету — платформа разберёт строки, " +
      "сверит прямые затраты (ФОТ + материалы + машины + оборудование + транспорт) и соберёт " +
      "8-листовой Excel: Контур А, Контур Б, риски, дефициты и маржу.<br><br>" +
      "<em>Пример:</em> смета на 12,4 млн ₽ → найдено 3 позиции с завышением и 2 пропуска работ.",
    calc: "<strong>Расчёт по ПД/РД.</strong> Тома PDF разбираются параллельно, из спецификаций " +
      "собирается ведомость объёмов с номерами листов, затем себестоимость и КП.<br><br>" +
      "<em>Пример:</em> КЖ на 25 листах → бетон В25 52,35 м³, арматура 4,89 т, КП за 1 клик.",
    drawings: "<strong>Чертежи ИИ-ПТО.</strong> Полистный аудит: паспорт чертежа, скрытые работы " +
      "по СП/ПУЭ, закладные и несоответствия.<br><br><em>Пример:</em> найден пропуск гильз " +
      "в фундаментной плите и отсутствие ведомости расхода стали.",
    chat: "<strong>Штаб стройки.</strong> Чаты организации и каналы объектов: сообщения, файлы и фото " +
      "в реальном времени, доступ по правам сотрудника.",
    gpr: "<strong>ГПР — КС-2 / КС-3.</strong> График производства работ с этапами, " +
      "рабочая смета по позициям и оформление актов КС-2 / КС-3 по ГОСТ.",
    finance: "<strong>Финансы.</strong> Приход/расход по объектам, счета и оплаты, субсчёт прораба. " +
      "Фильтры открыты по умолчанию, данные общие с приложением.",
    object: "<strong>Объект, фотоотчёт и камера.</strong> Паспорт объекта, обложка в общем облаке " +
      "организации, фотофиксация по этапам и LIVE-поток с площадки.",
  };

  function openModuleDemo(key) {
    var text = MODULE_DEMO_TEXT[key];
    if (!text) return;
    var item = MODULE_SHOWCASE.filter(function (row) { return row.key === key; })[0] || {};
    openModal((item.icon || "") + " " + (item.title || "Демо"),
      '<div class="demo-shot">' + text + "</div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="demo-register" type="button">' +
      "Попробовать на своём объекте → Регистрация</button></div>");
    $("#demo-register").addEventListener("click", function () {
      closeModal();
      openRegistration("company_owner");
    });
  }

  /// Пробная карточка «Триал 10 дней» в модальном окне тарифов.
  function pricingTrialHtml() {
    return '<div class="pricing-trial-card">' +
      '<div><strong>Триал — 10 дней бесплатно</strong>' +
      '<div class="pricing-trial-sub">1 объект · 2 сотрудника · 2 ИИ-разбора смет · ' +
      "1 том ПД/РД · 15 сообщений чата ИИ-ПТО · 3 проверки договора</div></div>" +
      '<button class="btn btn-outline btn-sm" id="pricing-trial-start" type="button">' +
      "Начать бесплатно</button></div>";
  }

  /// Тарифы и подписка — реальная витрина (V194.6.0 ТЗ §6, V194.6.1 ТЗ §1):
  /// сетка живёт в модальном окне верхней кнопки «Тарифы», а не в потоке главной.
  function openTariffsModal() {
    openModal("Тарифы НейроПлана",
      pricingTestBannerHtml() +
      '<div class="pricing-trial">10 дней бесплатно · ' + esc(TARIFF_PROMO_TITLE) + "</div>" +
      pricingTrialHtml() +
      '<div class="pricing-switch">' +
      '<button type="button" data-pricing-period="monthly" class="active">Помесячно</button>' +
      '<button type="button" data-pricing-period="yearly">За год (−20 %)</button>' +
      "</div>" +
      '<div class="pricing-grid" id="pricing-grid"></div>' +
      '<p class="pricing-options">Онлайн-оплата картой, по СБП или по счёту будет подключена ' +
      "позднее — сейчас платформа работает в режиме открытого тестирования и весь функционал " +
      "доступен бесплатно. Дополнительные лимиты ИИ и облачное хранилище предоставляются " +
      "бесплатно по запросу разработчику.</p>", "tariffs");
    bindPricing($("#modal-body"));
    var trialBtn = $("#pricing-trial-start");
    if (trialBtn) trialBtn.addEventListener("click", function () {
      closeModal();
      openRegistration("company_owner", "", "trial");
    });
    var testContact = $("#pricing-test-contact");
    if (testContact) testContact.addEventListener("click", function () {
      openFeedbackModal("support");
    });
  }

  /// V194.6.5: плашка над карточками тарифов — онлайн-оплата временно недоступна.
  function pricingTestBannerHtml() {
    return '<div class="pricing-test-banner">' +
      "<strong>Онлайн-оплата временно недоступна</strong>" +
      '<p class="small">' + esc(PRICING_TEST_NOTE) + "</p>" +
      '<button class="btn btn-outline btn-sm" id="pricing-test-contact" type="button">' +
      "Запросить дополнительные лимиты</button></div>";
  }

  function compareRow(op, old, neu) {
    return "<tr><td><strong>" + esc(op) + "</strong></td><td>" + esc(old) +
      "</td><td><strong>" + esc(neu) + "</strong></td></tr>";
  }
  function roleCard(title, text) {
    return '<div class="card"><h3>' + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
  }
  /// V194.6.2 (ТЗ §2): карточка сценария обучения с inline-SVG схемой.
  function learnCard(title, text, svg) {
    return '<div class="learn-card">' +
      '<div class="learn-art">' + (svg || "") + "</div>" +
      "<h3>" + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
  }

  // ── Inline-SVG мини-схемы карточек «Обучение» (без внешних картинок) ──
  function learnSvgWrap(inner) {
    return '<svg class="learn-svg" viewBox="0 0 120 72" role="img" aria-hidden="true" ' +
      'xmlns="http://www.w3.org/2000/svg">' + inner + "</svg>";
  }

  function learnSvgEstimate() {
    return learnSvgWrap(
      '<rect x="4" y="10" width="38" height="50" rx="4" fill="#EFF6FF" stroke="#93C5FD"/>' +
      '<rect x="9" y="17" width="28" height="4" rx="2" fill="#BFDBFE"/>' +
      '<rect x="9" y="25" width="22" height="3" rx="1.5" fill="#CBD5E1"/>' +
      '<rect x="9" y="32" width="26" height="3" rx="1.5" fill="#CBD5E1"/>' +
      '<rect x="9" y="39" width="18" height="3" rx="1.5" fill="#CBD5E1"/>' +
      '<rect x="9" y="48" width="12" height="3" rx="1.5" fill="#94A3B8"/>' +
      '<rect x="47" y="26" width="6" height="34" rx="2" fill="#93C5FD"/>' +
      '<rect x="56" y="16" width="6" height="44" rx="2" fill="#60A5FA"/>' +
      '<rect x="65" y="34" width="6" height="26" rx="2" fill="#3B82F6"/>' +
      '<rect x="78" y="10" width="38" height="50" rx="4" fill="#F8FAFC" stroke="#94A3B8"/>' +
      '<path d="M84 46 L96 28 L108 46" fill="none" stroke="#475569" stroke-width="2"/>' +
      '<path d="M84 52 H108" stroke="#CBD5E1" stroke-width="2"/>' +
      '<path d="M92 22 H104" stroke="#CBD5E1" stroke-width="2"/>');
  }

  function learnSvgGpr() {
    return learnSvgWrap(
      '<rect x="4" y="8" width="70" height="56" rx="4" fill="#F8FAFC" stroke="#CBD5E1"/>' +
      '<path d="M4 20 H74" stroke="#CBD5E1"/>' +
      '<rect x="9" y="26" width="34" height="7" rx="3.5" fill="#3B82F6"/>' +
      '<rect x="26" y="37" width="34" height="7" rx="3.5" fill="#60A5FA"/>' +
      '<rect x="17" y="48" width="34" height="7" rx="3.5" fill="#93C5FD"/>' +
      '<rect x="80" y="10" width="36" height="24" rx="4" fill="#ECFDF5" stroke="#6EE7B7"/>' +
      '<text x="84" y="22" font-size="7" font-family="Arial" fill="#047857">ПЛАН</text>' +
      '<text x="104" y="22" font-size="7" font-family="Arial" fill="#047857">ФАКТ</text>' +
      '<rect x="84" y="26" width="8" height="4" rx="2" fill="#10B981"/>' +
      '<rect x="96" y="26" width="12" height="4" rx="2" fill="#34D399"/>' +
      '<rect x="80" y="40" width="36" height="24" rx="4" fill="#EFF6FF" stroke="#BFDBFE"/>' +
      '<rect x="85" y="46" width="18" height="3" rx="1.5" fill="#93C5FD"/>' +
      '<rect x="85" y="52" width="26" height="3" rx="1.5" fill="#CBD5E1"/>' +
      '<rect x="85" y="58" width="14" height="3" rx="1.5" fill="#CBD5E1"/>');
  }

  function learnSvgKs() {
    return learnSvgWrap(
      '<rect x="8" y="8" width="54" height="56" rx="4" fill="#FFFFFF" stroke="#94A3B8"/>' +
      '<rect x="14" y="14" width="30" height="4" rx="2" fill="#CBD5E1"/>' +
      '<path d="M14 26 H56 M14 34 H56 M14 42 H56 M14 50 H48" stroke="#E2E8F0" stroke-width="2"/>' +
      '<circle cx="52" cy="50" r="11" fill="none" stroke="#2563EB" stroke-width="2.5"/>' +
      '<text x="46" y="53" font-size="7" font-family="Arial" fill="#1D4ED8">344</text>' +
      '<rect x="70" y="12" width="44" height="18" rx="4" fill="#ECFDF5" stroke="#34D399"/>' +
      '<text x="76" y="24" font-size="8" font-family="Arial" fill="#047857">.xlsx</text>' +
      '<rect x="70" y="36" width="44" height="18" rx="4" fill="#EFF6FF" stroke="#93C5FD"/>' +
      '<text x="76" y="48" font-size="8" font-family="Arial" fill="#1D4ED8">.docx</text>');
  }

  function learnSvgLegal() {
    return learnSvgWrap(
      '<rect x="12" y="6" width="60" height="60" rx="4" fill="#FFFFFF" stroke="#94A3B8"/>' +
      '<path d="M20 16 H58 M20 24 H64 M20 32 H56 M20 40 H62 M20 48 H50 M20 56 H44" ' +
      'stroke="#E2E8F0" stroke-width="3"/>' +
      '<circle cx="76" cy="44" r="15" fill="rgba(37,99,235,0.10)" stroke="#2563EB" stroke-width="3"/>' +
      '<path d="M87 55 L98 66" stroke="#2563EB" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M70 40 L75 46 L83 36" fill="none" stroke="#059669" stroke-width="3"/>' +
      '<path d="M62 12 L70 12 L70 20" fill="none" stroke="#F59E0B" stroke-width="2"/>');
  }

  function learnSvgDrawings() {
    return learnSvgWrap(
      '<rect x="6" y="8" width="54" height="56" rx="4" fill="#F8FAFC" stroke="#CBD5E1"/>' +
      '<path d="M12 50 H54 M12 20 H54 M12 20 V50 M54 20 V50" stroke="#94A3B8" stroke-width="1.5"/>' +
      '<path d="M18 50 V34 H30 V50" fill="none" stroke="#3B82F6" stroke-width="2"/>' +
      '<path d="M36 50 V26 H48 V50" fill="none" stroke="#60A5FA" stroke-width="2"/>' +
      '<rect x="62" y="18" width="54" height="40" rx="8" fill="#EFF6FF" stroke="#93C5FD"/>' +
      '<path d="M70 54 L66 62 L78 54" fill="#EFF6FF" stroke="#93C5FD"/>' +
      '<text x="68" y="34" font-size="8" font-family="Arial" fill="#1D4ED8">ИИ-ПТО</text>' +
      '<text x="68" y="47" font-size="8" font-family="Arial" fill="#475569">Лист 12</text>');
  }

  // ───────────────────────── Вход по QR-коду ─────────────────────────
  async function openQrLogin() {
    openModal("Вход по QR-коду", '<div class="muted">Создаём сессию…</div>');
    var created = await invokeQr({
      action: "create",
      device_label: "Браузер · " + (navigator.platform || "web"),
    });
    if (!created.ok) {
      $("#modal-body").innerHTML =
        '<div class="warn-box">Не удалось создать QR-сессию (' + esc(created.error || "error") +
        "). Проверьте соединение и повторите." + "</div>" +
        '<div class="mt-16"><button class="btn btn-navy" id="qr-retry" type="button">Повторить</button></div>';
      var retryNode = $("#qr-retry");
      if (retryNode) retryNode.addEventListener("click", openQrLogin);
      return;
    }
    var deepLink = "neyroplan://qr?token=" + created.token;
    $("#modal-body").innerHTML =
      '<div class="qr-box"><div><div class="qr-canvas" id="qr-canvas"></div>' +
      '<div class="mt-8 small muted">QR-код обновится через ' +
      '<strong id="qr-countdown">180</strong> сек</div></div>' +
      '<div class="qr-steps" style="flex:1;min-width:240px;">' +
      "<strong>Как войти:</strong><ol>" +
      "<li>Откройте НейроПлан на телефоне → Профиль → «Подключить компьютер».</li>" +
      "<li>Наведите камеру на QR-код.</li>" +
      "</ol>" +
      '<div class="mt-16" id="qr-status"><span class="pill pill-warn">Ожидаем подтверждение с телефона</span></div>' +
      '<div class="mt-16"><button class="btn btn-outline btn-sm" id="qr-event" type="button">Открыть в приложении</button></div>' +
      "</div></div>";

    try {
      // В QR-код кладём deep link приложения: камера телефона открывает НейроПлан
      // и сразу подтверждает вход (qr-auth confirm/approve), а не страницу браузера.
      new window.QRCode($("#qr-canvas"), {
        text: deepLink, width: 216, height: 216,
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      $("#qr-canvas").innerHTML =
        '<div class="small mono" style="word-break:break-all;">' + esc(deepLink) + "</div>";
    }
    $("#qr-event").addEventListener("click", function () { location.href = deepLink; });
    startQrCountdown(created.expires_at);

    // Realtime: строка web_qr_sessions меняет статус pending → confirmed.
    try {
      state.qrUnsub = sb.channel("qr-" + created.token)
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: "web_qr_sessions",
          filter: "token=eq." + created.token,
        }, function (payload) {
          if (payload && payload.new && payload.new.status === "confirmed") {
            exchangeQr(created.token);
          }
        })
        .subscribe();
    } catch (e) { /* ниже работает резервный опрос статуса */ }

    state.qrTimer = setInterval(function () {
      pollQrStatus(created.token, created.expires_at);
    }, 2000);
  }

  /// Обратный отсчёт жизни QR-кода (визуальный таймер вместо текстового кода).
  function startQrCountdown(expiresAt) {
    var deadline = expiresAt ? Date.parse(expiresAt) : 0;
    if (!deadline) return;
    clearInterval(startQrCountdown._t);
    startQrCountdown._t = setInterval(function () {
      var node = $("#qr-countdown");
      if (!node) { clearInterval(startQrCountdown._t); return; }
      var left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      node.textContent = String(left);
      if (left <= 0) clearInterval(startQrCountdown._t);
    }, 1000);
  }

  async function pollQrStatus(token, expiresAt) {
    var status = await invokeQr({ action: "status", token: token });
    var node = $("#qr-status");
    if (!node) { closeQrTimers(); return; }
    if (status.ok && status.status === "confirmed") { exchangeQr(token); return; }
    var expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
    if (expired || (status.ok && status.status === "expired")) {
      node.innerHTML = '<span class="pill pill-bad">Код истёк</span> ' +
        '<button class="btn btn-navy btn-sm" id="qr-again" type="button">Новый QR-код</button>';
      var againNode = $("#qr-again");
      if (againNode) againNode.addEventListener("click", openQrLogin);
      closeQrTimers();
    }
  }

  function closeQrTimers() {
    if (state.qrTimer) { clearInterval(state.qrTimer); state.qrTimer = null; }
    if (state.qrUnsub) { try { state.qrUnsub.unsubscribe(); } catch (e) {} state.qrUnsub = null; }
  }

  // ───────────── V192.2 (ТЗ §1): отзыв веб-сессии с телефона ─────────────
  // Браузер хранит token + id своей строки web_qr_sessions, слушает Realtime
  // UPDATE по id=eq.<session_id> и раз в 20 секунд опрашивает строку страховочно.
  // Как только телефон отзывает сеанс (revoked) или он истёк (expired), веб-клиент
  // немедленно делает signOut, чистит локальный токен и уводит на экран входа.

  function readWebSession() {
    try {
      var raw = localStorage.getItem(WEB_SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveWebSession(token, sessionId) {
    try {
      localStorage.setItem(WEB_SESSION_KEY, JSON.stringify({
        token: String(token || ""),
        session_id: String(sessionId || ""),
        saved_at: new Date().toISOString(),
      }));
    } catch (e) { /* приватный режим: слежение продолжится из памяти */ }
  }

  function clearWebSession() {
    try { localStorage.removeItem(WEB_SESSION_KEY); } catch (e) {}
  }

  function stopSessionWatch() {
    var watch = state.sessionWatch;
    if (watch.channel) {
      try { watch.channel.unsubscribe(); } catch (e) {}
      watch.channel = null;
    }
    if (watch.timer) {
      clearInterval(watch.timer);
      watch.timer = null;
    }
  }

  function startSessionWatch(token, sessionId) {
    stopSessionWatch();
    var watch = state.sessionWatch;
    watch.token = String(token || "");
    watch.sessionId = String(sessionId || "");
    if (!watch.token && !watch.sessionId) return;
    var filter = watch.sessionId
      ? "id=eq." + watch.sessionId
      : "token=eq." + watch.token;
    try {
      watch.channel = sb.channel("web-session-" + (watch.sessionId || watch.token))
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: "web_qr_sessions", filter: filter,
        }, function (payload) {
          applySessionRow(payload && payload.new);
        })
        .subscribe();
    } catch (e) { /* остаётся страховочный опрос */ }
    watch.timer = setInterval(checkSessionAlive, WEB_SESSION_POLL_MS);
  }

  function applySessionRow(row) {
    if (!row || typeof row !== "object") return;
    var status = String(row.status || "");
    if (status === "revoked") {
      terminateWebSession("revoked");
      return;
    }
    if (status === "expired") {
      terminateWebSession("expired");
      return;
    }
    // V192.6: жёсткий срок жизни веб-устройства — 7 дней с момента QR-входа.
    var expiresTs = Date.parse(String(row.expires_at || ""));
    if (Number.isFinite(expiresTs) && expiresTs <= Date.now()) {
      terminateWebSession("lifetime");
      return;
    }
    
  }

  async function checkSessionAlive() {
    var watch = state.sessionWatch;
    if (!watch.token && !watch.sessionId) return;
    try {
      var query = sb.from("web_qr_sessions").select("id, status, expires_at, purpose");
      query = watch.sessionId ? query.eq("id", watch.sessionId) : query.eq("token", watch.token);
      var res = await query.maybeSingle();
      if (!res.error && res.data) {
        applySessionRow(res.data);
        return;
      }
    } catch (e) { /* сеть/RLS — проверяем через Edge Function ниже */ }
    if (!watch.token) return;
    var status = await invokeQr({ action: "status", token: watch.token });
    if (status && status.ok) {
      applySessionRow({ status: status.status, expires_at: status.expires_at });
    }
  }

  async function terminateWebSession(reason) {
    if (state.sessionTerminating) return;
    state.sessionTerminating = true;
    stopSessionWatch();
    clearWebSession();
    // V193.9: выход ТОЛЬКО локальный — иначе GoTrue (scope=global по умолчанию)
    // отзывает refresh-токены всех устройств, и телефон вылетает на экран входа
    // через час простоя.
    try { await sb.auth.signOut({ scope: "local" }); } catch (e) { /* сессия уже недействительна */ }
    state.profile = null;
    state.userId = null;
    state.userEmail = "";
    state.orgId = 0;
    state.orgName = "";
    state.isSuper = false;
    state.adminVerifiedUntil = 0;
    state.legalV2 = null;
    clearAdminVerified();
    closeQrTimers();
    closeModal();
    renderSessionBadge();
    state.sessionTerminating = false;
    location.hash = "#/";
    renderRoute();
    if (reason === "lifetime") {
      toast("Срок веб-сессии (7 дней) истёк — отсканируйте QR-код заново", 9000);
    } else {
      toast("Сеанс завершён с мобильного устройства", 6000);
    }
    showSessionEndedNotice(reason);
  }

  function showSessionEndedNotice(reason) {
    var title = reason === "lifetime" ? "Срок веб-сессии истёк" : "Сеанс завершён";
    var text = reason === "lifetime"
      ? "Срок веб-сессии (7 дней) истёк — отсканируйте QR-код заново, чтобы продолжить работу в кабинете."
      : "Сеанс завершён с мобильного устройства. Веб-кабинет закрыт — чтобы продолжить, войдите заново.";
    openModal(title,
      '<div class="warn-box">' + text + "</div>" +
      '<div class="mt-16 flex">' +
      '<button class="btn btn-navy" id="session-again" type="button">Войти по QR-коду</button>' +
      '<button class="btn btn-outline" id="session-email" type="button">Вход по Email и паролю</button>' +
      "</div>");
    var qrBtn = $("#session-again");
    if (qrBtn) qrBtn.addEventListener("click", openQrLogin);
    var emailBtn = $("#session-email");
    if (emailBtn) emailBtn.addEventListener("click", openEmailLogin);
  }

  async function exchangeQr(token) {
    closeQrTimers();
    var exchanged = await invokeQr({ action: "exchange", token: token });
    if (!exchanged.ok || !exchanged.access_token) {
      var node = $("#qr-status");
      if (node) {
        node.innerHTML = '<span class="pill pill-bad">' + esc(exchanged.error || "Ошибка входа") + "</span>";
      }
      return;
    }
    var res = await sb.auth.setSession({
      access_token: exchanged.access_token,
      refresh_token: exchanged.refresh_token || "",
    });
    if (res.error) { toast("Не удалось установить сессию: " + res.error.message); return; }
    await loadProfile();
    renderSessionBadge();
    // V192.2 (ТЗ §1): запоминаем id строки web_qr_sessions и включаем наблюдение,
    // чтобы «Завершить сеанс» с телефона мгновенно гасил этот веб-кабинет.
    var sessionId = String(exchanged.session_id || "");
    if (!sessionId) {
      try {
        var rowRes = await sb.from("web_qr_sessions").select("id").eq("token", token).maybeSingle();
        if (rowRes && rowRes.data && rowRes.data.id) sessionId = String(rowRes.data.id);
      } catch (e) { /* fallback: следим по token */ }
    }
    saveWebSession(token, sessionId);
    startSessionWatch(token, sessionId);
    closeModal();
    toast("Вход по QR-коду выполнен");
    location.hash = "#/cabinet";
  }

  // ───────────────────── Резервный вход по Email и паролю ─────────────────────
  function openEmailLogin() {
    openModal("Вход по Email и паролю",
      '<label class="field"><span>Email</span><input type="email" id="login-email" autocomplete="username" /></label>' +
      '<label class="field"><span>Пароль</span><input type="password" id="login-password" autocomplete="current-password" /></label>' +
      '<div id="login-error" class="small" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="login-submit" type="button">Войти</button>' +
      '<button class="btn btn-outline" id="login-qr" type="button">Войти по QR-коду</button></div>');
    $("#login-qr").addEventListener("click", openQrLogin);
    $("#login-submit").addEventListener("click", async function () {
      var email = $("#login-email").value.trim();
      var password = $("#login-password").value;
      var errorNode = $("#login-error");
      if (!email || !password) { errorNode.textContent = "Введите email и пароль"; return; }
      errorNode.textContent = "";
      var res = await sb.auth.signInWithPassword({ email: email, password: password });
      if (res.error) { errorNode.textContent = res.error.message; return; }
      await loadProfile();
      renderSessionBadge();
      closeModal();
      toast("Вход выполнен");
      location.hash = "#/cabinet";
    });
  }

  // ─────────────────────────── Кабинет подрядчика ───────────────────────────
  async function requireAuth(root) {
    if (!state.userId) await loadProfile();
    if (!state.userId) {
      root.innerHTML = '<div class="card"><h3>Нужен вход</h3>' +
        '<p>Кабинет открывается после входа с телефона по QR-коду или по Email и паролю.</p>' +
        '<div class="mt-16 flex"><button class="btn btn-primary" id="auth-qr" type="button">Войти по QR-коду</button>' +
        '<button class="btn btn-outline" id="auth-email" type="button">Вход по Email и паролю</button></div></div>';
      $("#auth-qr").addEventListener("click", openQrLogin);
      $("#auth-email").addEventListener("click", openEmailLogin);
      return false;
    }
    return true;
  }

  // ═════════ V194.5.6-B (ТЗ §2): раздел «Чертежи» — реестр и ИИ-ПТО ═════════
  /// Реестр чертежей объекта: загрузка PDF/сканов, просмотр и ИИ-анализ.
  async function renderDrawings(root) {
    root.innerHTML = '<div class="muted">Загрузка реестра чертежей…</div>';
    if (!(await requireAuth(root))) return;
    if (orgMissing()) {
      renderNoOrgMode(root, { title: "Чертежи доступны после привязки организации" });
      return;
    }
    try {
      if (!(state.projects || []).length) await loadProjectsList();
      var projectId = num(state.activeProjectId);
      var res = await sb.from("project_drawings")
        .select("id, project_id, organization_id, code, title, section, revision, date, " +
          "status, file_path, file_url, file_name, file_size, ai_status, ai_error, created_at")
        .eq("organization_id", state.orgId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (res.error) throw res.error;
      var rows = (res.data || []).filter(function (row) {
        return !projectId || num(row.project_id) === projectId;
      });
      var project = activeProject();
      root.innerHTML =
        '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
        '<div><h2 class="section-title" style="margin:0;">Чертежи</h2>' +
        '<p class="section-sub" style="margin:4px 0 0;">Реестр чертежей объекта «' +
        esc((project && project.name) || "не выбран") + '»: загрузка, просмотр и ИИ-анализ ПТО.</p></div>' +
        '<label class="btn btn-navy" for="drawing-file" style="cursor:pointer;">' +
        "+ Загрузить чертёж</label>" +
        '<input id="drawing-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.dwg" class="hidden" />' +
        "</div>" +
        '<div id="obj-switcher-slot" class="mt-16"></div>' +
        (rows.length
          ? '<div class="card mt-16"><div class="table-wrap" style="max-height:58vh;overflow:auto;">' +
            '<table class="data"><thead><tr><th>Код</th><th>Наименование</th><th>Раздел</th>' +
            '<th>Рев.</th><th>Статус</th><th>ИИ-ПТО</th><th></th></tr></thead><tbody>' +
            rows.map(drawingRowHtml).join("") + "</tbody></table></div></div>"
          : '<div class="warn-box mt-16">Чертежей пока нет — загрузите первый PDF или скан. ' +
            "Он появится в реестре и в мобильном приложении.</div>");
      mountObjectSwitcher();
      var input = $("#drawing-file");
      if (input) {
        input.addEventListener("change", function (event) {
          uploadDrawings(event.target.files);
          event.target.value = "";
        });
      }
      $all("[data-draw-open]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          openDrawingFile(btn.getAttribute("data-draw-path") || "",
            btn.getAttribute("data-draw-url") || "");
        });
      });
      $all("[data-draw-ai]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          runDrawingAi(btn.getAttribute("data-draw-ai"));
        });
      });
      $all("[data-draw-chat]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          openDrawingChat(btn.getAttribute("data-draw-chat") || "",
            btn.getAttribute("data-draw-code") || "");
        });
      });
      $all("[data-draw-del]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          deleteDrawingTome(btn.getAttribute("data-draw-del"),
            btn.getAttribute("data-draw-file") || "",
            btn.getAttribute("data-draw-title") || "");
        });
      });
    } catch (err) {
      console.error("[drawings] реестр не загрузился:", err);
      renderFailure(root, "Реестр чертежей не загрузился",
        (err && err.message ? err.message : String(err)),
        function () { renderDrawings(root); });
    }
  }

  function drawingRowHtml(row) {
    // V194.5.6-D (ТЗ §5): статусы индексации — как во Flutter
    // (`uploaded` → `indexing` → `indexed` / `error`).
    var ai = String(row.ai_status || "").toLowerCase();
    var aiPill = (ai === "indexed" || ai === "done")
      ? pill("Проиндексирован", "ok")
      : (ai === "indexing" ? pill("Анализ…", "info")
        : (ai === "error" ? pill("Ошибка", "bad")
          : pill("Не анализировался", "warn")));
    return "<tr><td><strong>" + esc(row.code || "—") + "</strong></td>" +
      "<td>" + esc(row.title || row.file_name || "Чертёж") + "</td>" +
      '<td class="small">' + esc(row.section || "—") + "</td>" +
      '<td class="small">' + esc(row.revision || "—") + "</td>" +
      '<td class="small">' + esc(row.status || "—") + "</td>" +
      "<td>" + aiPill + "</td>" +
      '<td><div class="flex" style="gap:6px;flex-wrap:wrap;">' +
      '<button class="btn btn-outline btn-sm" data-draw-open="' + esc(row.id) +
      '" data-draw-path="' + esc(row.file_path || "") +
      '" data-draw-url="' + esc(row.file_url || "") + '" type="button">Открыть</button>' +
      '<button class="btn btn-navy btn-sm" data-draw-ai="' + esc(row.id) +
      '" type="button">ИИ-анализ</button>' +
      '<button class="btn btn-outline btn-sm" data-draw-chat="' + esc(row.id) +
      '" data-draw-code="' + esc(row.code || "") +
      '" type="button">Чат с ИИ-ПТО</button>' +
      // V194.6.2 (ТЗ §5): удаление тома из реестра и Storage.
      '<button class="btn btn-danger btn-sm" data-draw-del="' + esc(row.id) +
      '" data-draw-file="' + esc(row.file_path || "") +
      '" data-draw-title="' + esc(row.title || row.file_name || "том") +
      '" type="button">Удалить</button></div></td></tr>';
  }

  /// V194.6.2 (ТЗ §5): удаление тома чертежей — запись + файл Storage.
  async function deleteDrawingTome(id, path, title) {
    var drawingId = num(id);
    if (!drawingId) return;
    var label = String(title || "том").trim();
    if (!window.confirm("Удалить том «" + label + "» из чертежей? Индекс и файл будут удалены.")) return;
    var del = await sb.from("project_drawings").delete()
      .eq("id", drawingId).eq("organization_id", state.orgId);
    if (del.error) {
      toast("Не удалось удалить том: " + del.error.message, 9000);
      return;
    }
    if (path) {
      try { await sb.storage.from("project_rd").remove([path]); } catch (e) { /* файл мог быть удалён */ }
    }
    toast("Том удалён из чертежей");
    renderRoute();
  }

  /// Загрузка чертежей в Storage + запись в реестр `project_drawings`.
  async function uploadDrawings(files) {
    if (!files || !files.length) return;
    if (!state.orgId) { toast("Организация не определена"); return; }
    var projectId = num(state.activeProjectId) || null;
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var safe = typeof sanitizeStorageKey === "function"
        ? sanitizeStorageKey(file.name) : String(file.name).replace(/[^\w.\-]+/g, "_");
      var path = state.orgId + "/drawings/" + Date.now() + "_" + (i + 1) + "_" + safe;
      try {
        var up = await sb.storage.from("project_rd")
          .upload(path, file, { upsert: true, contentType: file.type || undefined });
        if (up.error) { toast("Чертёж не загружен: " + up.error.message, 7000); continue; }
        var ins = await sb.from("project_drawings").insert({
          project_id: projectId,
          organization_id: state.orgId,
          code: String(file.name.replace(/\.[^.]+$/, "")).slice(0, 40),
          title: String(file.name).slice(0, 200),
          section: "",
          revision: "",
          status: "Загружен",
          file_path: path,
          file_name: String(file.name).slice(0, 200),
          file_size: file.size || 0,
          ai_status: "new",
        });
        if (ins.error) { toast("Запись чертежа не сохранена: " + ins.error.message, 7000); continue; }
        added++;
      } catch (e) {
        toast("Ошибка загрузки чертежа: " + ((e && e.message) || e), 7000);
      }
    }
    if (added) {
      toast("Чертежей добавлено: " + added);
      renderRoute();
    }
  }

  /// Открыть файл чертежа: публичная ссылка либо signed URL из Storage.
  async function openDrawingFile(path, url) {
    if (url) { window.open(url, "_blank", "noopener"); return; }
    if (!path) { toast("У чертежа нет файла в облаке"); return; }
    var signed = await sb.storage.from("project_rd").createSignedUrl(path, 3600);
    if (signed.error) { toast("Не удалось открыть чертёж: " + signed.error.message, 7000); return; }
    window.open(signed.data.signedUrl, "_blank", "noopener");
  }

  /// V194.5.6-D (ТЗ §5): «ИИ-анализ» ставит чертёж в очередь индексации.
  ///
  /// Индексирует python-воркер (`rd_indexer.process_pending` по `ai_status`):
  /// ставим `indexing`, будим контейнер ping-ом /health и обновляем реестр,
  /// пока статус не станет `indexed` (как на телефоне). Никакого вызова
  /// несуществующей Edge Function — кнопка больше не «молчит».
  async function runDrawingAi(id) {
    var drawingId = num(id);
    if (!drawingId) return;
    try {
      var upd = await sb.from("project_drawings").update({
        ai_status: "indexing",
        ai_started_at: new Date().toISOString(),
        ai_error: null,
      }).eq("id", drawingId).eq("organization_id", state.orgId);
      if (upd.error) throw upd.error;
      toast("ИИ-ПТО взял чертёж в работу — статус обновится автоматически");
      // Пинг воркера (fire-and-forget): контейнер просыпается и забирает задачу.
      var workerBase = String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
      if (workerBase && typeof fetch === "function") {
        fetch(workerBase + "/health").catch(function () {});
      }
      renderRoute();
      var attempts = 0;
      var timer = window.setInterval(async function () {
        attempts += 1;
        var res = await sb.from("project_drawings").select("ai_status, ai_error")
          .eq("id", drawingId).eq("organization_id", state.orgId).maybeSingle();
        var status = String((res && res.data && res.data.ai_status) || "").toLowerCase();
        if (status === "indexed" || status === "done") {
          window.clearInterval(timer);
          toast("Чертёж проиндексирован: откройте «Чат с ИИ-ПТО»");
          renderRoute();
          return;
        }
        if (status === "error" || attempts >= 45) {
          window.clearInterval(timer);
          toast(status === "error"
            ? ("ИИ-анализ не выполнен: " +
              String((res && res.data && res.data.ai_error) || "ошибка индексации"))
            : "Индексация занимает больше времени — проверьте реестр позже", 8000);
          renderRoute();
        }
      }, 4000);
    } catch (e) {
      var text = String((e && e.message) || e);
      toast("ИИ-анализ не запущен: " + text, 8000);
    }
  }

  /// V194.5.6-D (ТЗ §5): чат с ИИ-ПТО по выбранному чертежу.
  ///
  /// Вопрос уходит в Edge Function `project-ai-assistant` (action `ask`) с
  /// `drawing_codes` выбранного чертежа — ответ строится по его паспорту РД.
  function openDrawingChat(drawingId, drawingCode) {
    var code = String(drawingCode || "").trim();
    var history = [];
    var chatId = 0;
    openModal("Чат с ИИ-ПТО" + (code ? " · " + code : ""),
      '<div id="draw-chat-log" class="small" style="max-height:42vh;overflow:auto;' +
      'background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:10px;">' +
      '<p class="muted">Задайте вопрос по этому чертежу: состав работ, узлы, ' +
      "спецификации, скрытые работы, риски ПТО.</p></div>" +
      '<div class="flex mt-8" style="gap:8px;align-items:flex-end;">' +
      '<label class="field" style="flex:1;"><span>Вопрос</span>' +
      '<input type="text" id="draw-chat-q" placeholder="Какие работы скрытые по этому листу?" /></label>' +
      '<button class="btn btn-navy" id="draw-chat-send" type="button">Спросить</button></div>');
    var log = $("#draw-chat-log");
    var input = $("#draw-chat-q");
    var button = $("#draw-chat-send");
    if (!button || !log || !input) return;
    function append(role, text) {
      var block = document.createElement("div");
      block.style.margin = "6px 0";
      block.innerHTML = "<strong>" + (role === "user" ? "Вы" : "ИИ-ПТО") + ":</strong> " +
        '<div style="white-space:pre-wrap;">' + esc(text) + "</div>";
      log.appendChild(block);
      log.scrollTop = log.scrollHeight;
    }
    // V194.5.6-E (ТЗ §5): история диалога хранится в тех же таблицах, что у Flutter
    // (`project_ai_chats` / `project_ai_memory` через Edge Function) — при закрытии
    // и повторном открытии чертежа переписка восстанавливается и синхронизируется
    // между ПК и телефоном.
    async function restoreHistory() {
      var projectId = num(state.activeProjectId) || null;
      if (!projectId || !state.orgId) return;
      try {
        var listRes = await sb.functions.invoke("project-ai-assistant", {
          body: { action: "list_chats", project_id: projectId, organization_id: state.orgId },
        });
        var chats = (listRes.data && listRes.data.chats) || [];
        var found = (chats || []).filter(function (chat) {
          var codes = chat.drawing_codes || [];
          if (typeof codes === "string") {
            try { codes = JSON.parse(codes); } catch (e) { codes = []; }
          }
          return code && Array.isArray(codes) && codes.indexOf(code) >= 0;
        })[0];
        if (!found) return;
        chatId = num(found.id);
        var res = await sb.functions.invoke("project-ai-assistant", {
          body: {
            action: "load_chat", chat_id: chatId,
            project_id: projectId, organization_id: state.orgId,
          },
        });
        var messages = (res.data && res.data.messages) || [];
        if (!messages.length) return;
        var hint = log.querySelector("p.muted");
        if (hint) hint.remove();
        messages.slice().reverse().forEach(function (message) {
          if (message.question_text) append("user", message.question_text);
          if (message.answer_text) append("assistant", message.answer_text);
          history.push({ question: message.question_text, answer: message.answer_text });
        });
      } catch (e) {
        console.warn("draw-chat history:", e);
      }
    }
    restoreHistory();
    async function ask() {
      var question = String(input.value || "").trim();
      if (!question) return;
      input.value = "";
      append("user", question);
      button.disabled = true;
      button.textContent = "Думаю…";
      try {
        var projectId = num(state.activeProjectId) || null;
        var body = {
          action: "ask",
          question: question,
          organization_id: state.orgId,
          project_id: projectId,
          drawing_codes: code ? [code] : [],
        };
        if (chatId > 0) body.chat_id = chatId;
        var res = await sb.functions.invoke("project-ai-assistant", { body: body });
        if (res.error) throw new Error(res.error.message || "ИИ-ПТО недоступен");
        var payload = res.data || {};
        var answer = String(payload.answer_text || payload.answer || payload.message || "").trim();
        if (!answer) answer = "Ответ не получен — попробуйте переформулировать вопрос.";
        if (num(payload.chat_id)) chatId = num(payload.chat_id);
        history.push({ question: question, answer: answer });
        append("assistant", answer);
      } catch (e) {
        append("assistant", "Ошибка: " + String((e && e.message) || e));
      } finally {
        button.disabled = false;
        button.textContent = "Спросить";
      }
    }
    button.addEventListener("click", ask);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); ask(); }
    });
    input.focus();
  }

  // ═════════ V194.5.5-C2: Демо-режим «Без организации» и понятные ошибки ═════════
  /// Канонический код роли текущего профиля (DIRECTOR / GUEST / …).
  function orgRoleCode() {
    return normalizeRoleCode(state.profile && state.profile.role);
  }

  /// Владелец объекта и состава команды — владелец платформы или директор.
  function canManageOrg() {
    if (state.isSuper) return true;
    if (!state.orgId) return false;
    return orgRoleCode() === "DIRECTOR";
  }

  /// Аккаунт вошёл, но организация не привязана (исключён или ещё не вступил).
  /// V194.6.3 (доп.): незавершённая регистрация сюда не попадает — у неё свой экран.
  function orgMissing() {
    return !!state.userId && !state.orgId && !state.isSuper && !state.pendingReg;
  }

  /// Понятный блок ошибки с кнопкой «Повторить» вместо вечной «Загрузка…».
  function renderFailure(root, title, detail, retry) {
    root.innerHTML = '<div class="card fail-box">' +
      "<h3>" + esc(title || "Раздел не загрузился") + "</h3>" +
      '<p class="small">' + esc(detail || "Неизвестная ошибка") + "</p>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="fail-retry" type="button">' +
      "Повторить</button>" + '<a class="btn btn-outline" href="#/cabinet">В Кабинет</a></div></div>';
    var btn = $("#fail-retry");
    if (btn) {
      btn.addEventListener("click", function () {
        if (typeof retry === "function") retry();
        else renderRoute();
      });
    }
  }

  /// Демо-режим: аккаунт без организации видит только ограниченный экран.
  function renderNoOrgMode(root, options) {
    var opts = options || {};
    root.innerHTML = '<section class="card no-org-mode">' +
      '<span class="no-org-chip">ДЕМО-РЕЖИМ · БЕЗ ОРГАНИЗАЦИИ</span>' +
      '<h2 class="section-title" style="margin:10px 0 6px;">' +
      esc(opts.title || "Ограниченный доступ") + "</h2>" +
      '<p class="small">' + esc(opts.text ||
        "Аккаунт не привязан к организации: объекты, сметы, финансы и чаты недоступны. " +
        "Введите код приглашения от руководителя или создайте свою организацию.") + "</p>" +
      '<div class="no-org-actions mt-16">' +
      '<button class="btn btn-navy" id="no-org-invite" type="button">Ввести код приглашения</button>' +
      '<button class="btn btn-outline" id="no-org-create" type="button">Создать свою организацию</button>' +
      "</div>" +
      '<p class="small muted mt-16">Пока аккаунт без организации, платформа не показывает данные ' +
      "ни одной компании — это защита от утечки чужих смет и финансов.</p></section>";
    var inviteBtn = $("#no-org-invite");
    if (inviteBtn) inviteBtn.addEventListener("click", function () { openInviteCodeModal(""); });
    var createBtn = $("#no-org-create");
    if (createBtn) createBtn.addEventListener("click", openCreateOrgModal);
  }


  /// Обновление состояния после смены организации (вход по коду / своя компания).
  async function refreshAfterOrgChange() {
    try { await loadProfile(); } catch (e) { /* профиль подтянется позже */ }
    try { await loadMyPermissions(); } catch (e) { /* права не блокируют вход */ }
    applyNavPermissions();
    state.projects = [];
    state.projectsError = "";
    state.activeProjectId = 0;
    try { localStorage.removeItem("np_active_project"); } catch (e) {}
    renderSessionBadge();
    if (state.orgId) {
      try { await loadProjectsList(); } catch (e) { /* список перечитает Кабинет */ }
    }
    renderRoute();
  }

  /// Ввод кода приглашения для аккаунта без организации.
  function openInviteCodeModal(prefill) {
    openModal("Ввод кода приглашения",
      '<p class="small muted">Код выдаёт руководитель организации в разделе «Команда».</p>' +
      '<label class="field"><span>Код приглашения</span>' +
      '<input type="text" id="join-code" autocomplete="off" placeholder="6–12 символов" value="' +
      esc(prefill || "") + '" /></label>' +
      '<div class="small" id="join-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="join-submit" type="button">' +
      "Присоединиться</button>" +
      '<button class="btn btn-outline" id="join-create" type="button">Создать свою организацию</button>' +
      "</div>");
    var createBtn = $("#join-create");
    if (createBtn) createBtn.addEventListener("click", openCreateOrgModal);
    var submit = $("#join-submit");
    if (submit) {
      submit.addEventListener("click", function () {
        joinOrganizationByCode($("#join-code") ? $("#join-code").value : "");
      });
    }
    var input = $("#join-code");
    if (input) {
      input.focus();
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") joinOrganizationByCode(input.value);
      });
    }
  }

  /// RPC accept_invitation: организация и роль ГОСТЬ подставляются автоматически.
  async function joinOrganizationByCode(code) {
    var clean = String(code || "").trim().toUpperCase();
    var errorNode = $("#join-error");
    var btn = $("#join-submit");
    if (!clean) {
      if (errorNode) errorNode.textContent = "Введите код приглашения";
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Присоединяемся…"; }
    if (errorNode) errorNode.textContent = "";
    try {
      var res = await sb.rpc("accept_invitation", { p_code: clean });
      if (res.error) throw new Error(res.error.message || "RPC недоступен");
      var payload = res.data || {};
      if (payload && payload.success === false) {
        throw new Error(payload.message || "Код приглашения недействителен");
      }
      closeModal();
      toast("Организация подключена — добро пожаловать в команду");
      await refreshAfterOrgChange();
    } catch (e) {
      var text = String((e && e.message) || e);
      if (errorNode) errorNode.textContent = "Не удалось присоединиться: " + text;
      else toast("Не удалось присоединиться: " + text, 7000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Присоединиться"; }
    }
  }

  /// Создание своей организации прямо из Демо-режима.
  function openCreateOrgModal() {
    openModal("Создание организации",
      '<p class="small muted">Организация, первый объект и профиль директора создаются одной ' +
      "операцией — после этого откроется полный Кабинет.</p>" +
      '<label class="field"><span>Название организации</span>' +
      '<input type="text" id="new-org-name" autocomplete="off" placeholder="ООО «СтройИнвест»" /></label>' +
      '<label class="field"><span>Первый объект</span>' +
      '<input type="text" id="new-org-project" value="Основной объект" /></label>' +
      '<label class="field"><span>ФИО руководителя</span>' +
      '<input type="text" id="new-org-director" value="' +
      esc((state.profile && state.profile.full_name) || "") + '" /></label>' +
      '<div class="small" id="new-org-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="new-org-submit" type="button">' +
      "Создать организацию</button></div>");
    var submit = $("#new-org-submit");
    if (submit) submit.addEventListener("click", createMyOrganization);
    var nameInput = $("#new-org-name");
    if (nameInput) nameInput.focus();
  }

  /// RPC create_my_organization: SECURITY DEFINER, user_id всегда auth.uid().
  async function createMyOrganization() {
    var name = String(($("#new-org-name") || {}).value || "").trim();
    var projectName = String(($("#new-org-project") || {}).value || "").trim();
    var director = String(($("#new-org-director") || {}).value || "").trim();
    var errorNode = $("#new-org-error");
    var btn = $("#new-org-submit");
    if (!name) {
      if (errorNode) errorNode.textContent = "Укажите название организации";
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Создаём…"; }
    if (errorNode) errorNode.textContent = "";
    try {
      var res = await sb.rpc("create_my_organization", {
        company_name: name,
        initial_project_name: projectName || "Основной объект",
        director_name: director || null,
      });
      if (res.error) throw new Error(res.error.message || "RPC недоступен");
      closeModal();
      toast("Организация создана");
      await refreshAfterOrgChange();
    } catch (e) {
      var text = String((e && e.message) || e);
      if (errorNode) errorNode.textContent = "Не удалось создать организацию: " + text;
      else toast("Не удалось создать организацию: " + text, 7000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Создать организацию"; }
    }
  }


  function estimateStatusPill(status) {
    var map = {
      queued: ["В очереди", "warn"], processing: ["Обработка", "info"],
      done: ["Готово", "ok"], failed: ["Ошибка", "bad"],
    };
    var pair = map[status] || [status || "—", "navy"];
    return pill(pair[0], pair[1]);
  }

  // ═════════ V194.5.5-web (ТЗ §2): Кабинет организации — 3 этажа + сводка ═════════

  /// Сметы организации для Кабинета (таблица живёт в разделе «Сметы»).
  async function cabinetJobs() {
    try {
      var res = await sb.from("estimate_jobs").select("*")
        .order("created_at", { ascending: false }).limit(60);
      if (res.error) return [];
      return res.data || [];
    } catch (e) {
      return [];
    }
  }

  /// Сметы, относящиеся к активному объекту (старые без `project_id` — тоже).
  function cabinetJobsForProject(jobs, projectId) {
    var list = jobs || [];
    var withProject = list.filter(function (job) { return job.project_id != null; });
    if (!projectId || !withProject.length) return list;
    return withProject.filter(function (job) { return num(job.project_id) === num(projectId); });
  }

  function cabinetMoneyTotals(jobs) {
    var contract = 0, market = 0;
    (jobs || []).forEach(function (job) {
      contract += num(job.contract_total);
      market += num(job.market_total);
    });
    var margin = contract > 0 ? ((contract - market) / contract) * 100 : 0;
    return { contract: contract, market: market, margin: margin };
  }

  async function cabinetGprPercent(projectId) {
    if (!projectId || !state.orgId) return 0;
    try {
      var res = await sb.from("gpr_stages")
        .select("plan_volume, fact_volume")
        .eq("organization_id", state.orgId)
        .eq("project_id", num(projectId));
      if (res.error || !res.data) return 0;
      var plan = 0, fact = 0;
      res.data.forEach(function (row) {
        plan += num(row.plan_volume);
        fact += num(row.fact_volume);
      });
      if (plan <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((fact / plan) * 100)));
    } catch (e) {
      return 0;
    }
  }

  async function cabinetTomesCount() {
    if (!state.orgId) return 0;
    try {
      // V194.5.5-C2.1: в public.project_calc_tomes организация хранится в
      // колонке org_id (колонки organization_id в таблице нет) — прежний
      // фильтр давал PostgREST 400 «column ... organization_id does not exist».
      var res = await sb.from("project_calc_tomes")
        .select("id", { count: "exact", head: true })
        .eq("org_id", state.orgId);
      if (res && !res.error) return num(res.count);
      if (res && res.error) {
        console.warn("[tomes] счётчик томов не получен:", res.error.message);
      }
    } catch (e) { /* нет таблицы/доступа — показываем 0 */ }
    return 0;
  }

  async function cabinetShiftsCount(days) {
    var since = new Date(Date.now() - num(days || 7) * 86400000).toISOString().slice(0, 10);
    try {
      var res = await sb.from("shift_items")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", state.orgId)
        .gte("shift_date", since);
      if (res && !res.error) return num(res.count);
    } catch (e) { /* таблица смен ещё не создана */ }
    return 0;
  }

  async function cabinetCounts(jobs) {
    var project = activeProject();
    var projectId = project ? num(project.id) : 0;
    var totals = cabinetMoneyTotals(cabinetJobsForProject(jobs, projectId));
    var counts = {
      jobsReady: (jobs || []).filter(function (job) { return job.status === "done"; }).length,
      jobsActive: (jobs || []).filter(function (job) {
        return job.status === "queued" || job.status === "processing";
      }).length,
      tomes: 0,
      gpr: 0,
      shifts: 0,
      contract: totals.contract,
      market: totals.market,
      margin: totals.margin,
    };
    counts.tomes = await cabinetTomesCount();
    counts.gpr = await cabinetGprPercent(projectId);
    counts.shifts = await cabinetShiftsCount(7);
    return counts;
  }

  async function renderCabinet(root) {
    root.innerHTML = '<div class="muted">Загрузка кабинета…</div>';
    if (!(await requireAuth(root))) return;
    if (orgMissing()) {
      // V194.5.5-C2 (ТЗ §3): исключённый сотрудник видит ограниченный Демо-режим.
      renderNoOrgMode(root, { title: "Кабинет в Демо-режиме" });
      return;
    }
    try {
      await loadProjectsList();
      try { await loadMyPermissions(); } catch (e) { /* права не блокируют кабинет */ }
      var jobs = await cabinetJobs();
      var counts = await cabinetCounts(jobs);
      state.cabinetJobs = jobs;
      state.cabinetCounts = counts;
      renderCabinetShell(root, jobs, counts);
      loadCabinetSubscription();
      try {
        if (typeof refreshChatUnread === "function") {
          refreshChatUnread().then(function () {
            var chatCell = $("#cab-chat-value");
            if (chatCell) chatCell.textContent = String(state.chatUnread || 0);
          }).catch(function () { /* счётчик не критичен */ });
        }
      } catch (badgeError) {
        console.warn("[badges]", badgeError);
      }
    } catch (err) {
      root.innerHTML = '<div class="warn-box">Кабинет не загрузился: ' +
        esc(err && err.message ? err.message : err) + "</div>";
    }
  }

  // ═════════ V194.6.0 (ТЗ §4): «Мой тариф и лимиты» в кабинете ═════════
  async function loadCabinetSubscription() {
    var box = $("#cab-subscription");
    if (!box || !num(state.orgId)) return;
    var res = await sb.rpc("get_org_subscription_summary", { p_org_id: num(state.orgId) });
    if (!box.isConnected) return;
    if (res.error || !res.data) {
      box.innerHTML = '<div class="small muted">Тариф не загрузился: ' +
        esc(res.error ? res.error.message : "нет данных") + "</div>";
      return;
    }
    var summary = res.data;
    box.innerHTML = cabinetSubscriptionHtml(summary);
    bindCabinetSubscription(summary);
  }

  function subLimitValue(limits, usage, limitKey, usedKey) {
    var limit = num(limits && limits[limitKey]);
    var used = num(usage && usage[usedKey]);
    return { limit: limit, used: used };
  }

  function subBarHtml(title, used, limit, suffix) {
    var unlimited = limit < 0;
    var ratio = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    var color = ratio >= 90 ? "#EF4444" : (ratio >= 70 ? "#F59E0B" : "#38BDF8");
    return '<div class="sub-bar"><div class="sub-bar-head"><span>' + esc(title) +
      "</span><strong>" + (unlimited ? "Безлимит" : used + (suffix || "") + " / " + limit) +
      "</strong></div>" +
      '<div class="sub-bar-track"><i style="width:' + (unlimited ? 0 : ratio) +
      "%;background:" + color + ';"></i></div></div>';
  }

  function cabinetSubscriptionHtml(summary) {
    var limits = summary.limits || {};
    var usage = summary.usage || {};
    var unlimited = !!summary.is_unlimited_override;
    var readOnly = !!summary.is_read_only;
    var days = num(summary.days_left);
    var statusColor = unlimited ? "#0284C7" : (readOnly ? "#DC2626"
      : (summary.plan_code === "trial" ? "#D97706" : "#10B981"));
    var statusText = unlimited ? "Безлимит (активирован администратором)"
      : (readOnly ? "Подписка истекла — только чтение"
        : (summary.plan_code === "trial" ? "Триал" : "Активен"));
    var expires = String(summary.plan_expires_at || "").slice(0, 10);
    var expiresText = expires
      ? "до " + expires.slice(8, 10) + "." + expires.slice(5, 7) + "." + expires.slice(0, 4)
      : "—";
    var metrics = [
      ["Сметы", "estimates_limit", "estimates_used", " / мес"],
      ["Тома ПД/РД", "pd_tomes_limit", "pd_tomes_used", " / мес"],
      ["Чат ИИ-ПТО", "ai_chat_limit", "ai_chat_used", " / мес"],
      ["Чеки OCR", "ocr_limit", "ocr_used", " / мес"],
      ["ИИ-юрист (договоры)", "legal_checks_limit", "legal_checks_used", " / мес"],
      ["Биржа объявлений", "marketplace_posts_limit", "marketplace_posts_used", " / мес"],
    ];
    return '<div class="flex-between"><div><div class="small muted">МОЙ ТАРИФ И ЛИМИТЫ</div>' +
      '<div class="sub-plan">' + esc(summary.plan_title || "Триал") +
      ' <span class="sub-status" style="background:' + statusColor + '22;color:' + statusColor +
      ";border:1px solid " + statusColor + '55;">' + esc(statusText) + "</span></div></div>" +
      '<button class="btn btn-outline btn-sm" id="sub-refresh" type="button">Обновить</button></div>' +
      (unlimited
        ? '<div class="sub-days sub-days--unlimited">Безлимит · ' + esc(expiresText) + "</div>"
        : '<div class="sub-days' + (days <= 3 ? " sub-days--warn" : "") + '">Осталось ' +
          days + " дн. <span>" + esc(expiresText) + "</span></div>") +
      (readOnly
        ? '<div class="warn-box mt-8">Данные не удалены: КС-2, КС-3, АОСР, КП и договоры можно ' +
          "открыть и скачать. Новые объекты и ИИ-операции доступны после продления тарифа.</div>"
        : "") +
      '<div class="sub-bars">' +
      metrics.map(function (item) {
        var pair = subLimitValue(limits, usage, item[1], item[2]);
        return subBarHtml(item[0], pair.used, pair.limit, item[3]);
      }).join("") +
      subBarHtml("Объекты", num(summary.objects_used), num(limits.max_objects), "") +
      subBarHtml("Сотрудники", num(summary.employees_used), num(limits.max_employees), "") +
      subBarHtml("Хранилище", 0, num(limits.storage_mb), " МБ") +
      "</div>" +
      '<div class="flex mt-8" style="flex-wrap:wrap;gap:8px;">' +
      '<button class="btn btn-navy btn-sm" id="sub-plan-btn" type="button">Сменить тариф / Продлить</button>' +
      (summary.ai_topup_available
        ? '<button class="btn btn-outline btn-sm" id="sub-ai-btn" type="button">Обновить лимит ИИ (' +
          num(summary.ai_reset_price_rub) + " ₽)</button>"
        : "") +
      (num(summary.extra_storage_gb_price_rub) > 0
        ? '<button class="btn btn-outline btn-sm" id="sub-storage-btn" type="button">+ Хранилище (' +
          num(summary.extra_storage_gb_price_rub) + " ₽/ГБ)</button>"
        : "") +
      "</div>" +
      ((summary.custom_dev_available || unlimited)
        ? '<div class="sub-extra"><strong>Интеграции (1С / Банк) и индивидуальная доработка</strong>' +
          '<div class="small muted">Разработаем дополнительный функционал под задачи вашей компании ' +
          "при наличии технической возможности — включая обмен с 1С и банковскими сервисами.</div>" +
          '<button class="btn btn-outline btn-sm mt-8" id="sub-dev-btn" type="button">Оставить запрос</button></div>'
        : "");
  }

  function cabinetObjectCard(project) {

  function bindCabinetSubscription(summary) {
    var refresh = $("#sub-refresh");
    if (refresh) refresh.addEventListener("click", loadCabinetSubscription);
    var planBtn = $("#sub-plan-btn");
    if (planBtn) planBtn.addEventListener("click", function () { openPlanRequestModal(summary); });
    var aiBtn = $("#sub-ai-btn");
    if (aiBtn) aiBtn.addEventListener("click", function () {
      submitBillingRequest({
        request_type: "ai_reset",
        target_plan_code: summary.plan_code,
        billing_period: summary.billing_period || "monthly",
        amount_rub: num(summary.ai_reset_price_rub),
        comment: "Обновление месячного лимита ИИ",
      }, "Заявка на обновление лимита ИИ отправлена");
    });
    var storageBtn = $("#sub-storage-btn");
    if (storageBtn) storageBtn.addEventListener("click", function () {
      openStorageRequestModal(summary);
    });
    var devBtn = $("#sub-dev-btn");
    if (devBtn) devBtn.addEventListener("click", function () {
      openCustomDevModal(summary);
    });
  }

  /// Заявка на оплату/счёт + фоновое письмо на neyroplan@mail.ru.
  async function submitBillingRequest(payload, successText) {
    var body = Object.assign({
      org_id: num(state.orgId) || null,
      user_id: state.userId || null,
      status: "new",
      org_name: state.orgName || "",
      contact_email: state.userEmail || "",
    }, payload);
    var res = await sb.from("billing_requests").insert(body);
    if (res.error) { toast("Заявка не сохранена: " + res.error.message, 7000); return false; }
    notifyBilling(body);
    toast(successText || "Заявка отправлена — счёт придёт на e-mail организации", 7000);
    return true;
  }

  function notifyBilling(body) {
    var endpoint = supportEndpoint();
    if (!endpoint) return;
    var message = "Заявка: " + (body.request_type || "") +
      "\nТариф: " + (body.target_plan_code || "—") +
      "\nПериод: " + (body.billing_period || "monthly") +
      "\nДоп. ГБ: " + (body.extra_gb || 0) +
      "\nСумма: " + (body.amount_rub || 0) + " ₽" +
      "\nОрганизация: " + (body.org_name || "—") +
      "\nКомментарий: " + (body.comment || "—");
    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "support",
          name: body.org_name || "",
          email: body.contact_email || SUPPORT_EMAIL,
          org_name: body.org_name || "",
          message: message,
          app_version: String(CFG.release || ""),
          platform: "web",
          page_url: String(location.href || "").slice(0, 500),
          user_id: state.userId || null,
          organization_id: num(state.orgId) || null,
        }),
      }).catch(function () {});

  function openPlanRequestModal(summary) {
    var options = TARIFF_MATRIX.map(function (plan) {
      return '<option value="' + esc(plan.code) + '"' +
        ((summary.plan_code || "trial") === plan.code ? " selected" : "") + ">" +
        esc(plan.title) + " — " + rubText(plan.price) + "/мес</option>";
    }).join("");
    openModal("Сменить тариф / Продлить",
      '<label class="field"><span>Тариф</span><select id="pr-plan">' + options + "</select></label>" +
      '<label class="field mt-8"><span>Период</span><select id="pr-period">' +
      '<option value="monthly"' + (summary.billing_period !== "yearly" ? " selected" : "") +
      ">Помесячно</option>" +
      '<option value="yearly"' + (summary.billing_period === "yearly" ? " selected" : "") +
      ">За год (−20 %)</option></select></label>" +
      '<label class="field mt-8"><span>Комментарий для счёта</span>' +
      '<input type="text" id="pr-comment" placeholder="Реквизиты, пожелания" /></label>' +
      '<p class="small muted mt-8">Оплата картой, по СБП или по счёту для ООО и ИП. ' +
      "Счёт придёт на e-mail организации.</p>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="pr-send" type="button">' +
      "Оформить заявку</button></div>");
    $("#pr-send").addEventListener("click", async function () {
      var plan = tariffPlan($("#pr-plan").value);
      var period = $("#pr-period").value;
      var comment = String($("#pr-comment") ? $("#pr-comment").value : "").trim();
      closeModal();
      await submitBillingRequest({
        request_type: summary.is_expired ? "renew" : "upgrade",
        target_plan_code: plan.code,
        billing_period: period,
        amount_rub: period === "yearly" ? plan.yearlyTotal : plan.price,
        comment: comment,
      }, "Заявка на тариф «" + plan.title + "» отправлена");
    });
  }

  function openStorageRequestModal(summary) {
    var price = num(summary.extra_storage_gb_price_rub) || 50;
    openModal("Дополнительное хранилище",
      '<label class="field"><span>Сколько ГБ добавить</span>' +
      '<input type="number" min="1" step="1" id="st-gb" value="5" /></label>' +
      '<p class="small muted mt-8">' + esc(summary.storage_label || "") +
      " · " + price + " ₽ за 1 ГБ/мес</p>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="st-send" type="button">' +
      "Отправить заявку</button></div>");
    $("#st-send").addEventListener("click", async function () {
      var gb = Math.max(1, Math.round(num($("#st-gb") ? $("#st-gb").value : 0)));
      closeModal();
      await submitBillingRequest({
        request_type: "storage_addon",
        target_plan_code: summary.plan_code,
        billing_period: summary.billing_period || "monthly",
        extra_gb: gb,
        amount_rub: gb * price,
        comment: "Расширение хранилища на " + gb + " ГБ",
      }, "Заявка на " + gb + " ГБ отправлена");
    });
  }

  function openCustomDevModal(summary) {
    openModal("Индивидуальная доработка / интеграции",
      '<p class="small">Опишите задачу: интеграция с 1С, банковские сервисы, отчёты под вашу ' +
      "компанию. Ответим с neyroplan@mail.ru и предложим решение.</p>" +
      '<label class="field mt-8"><span>Задача</span>' +
      '<textarea id="cd-comment" rows="3" placeholder="Что нужно доработать"></textarea></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="cd-send" type="button">' +
      "Оставить запрос</button></div>");
    $("#cd-send").addEventListener("click", async function () {
      var comment = String($("#cd-comment") ? $("#cd-comment").value : "").trim();
      closeModal();
      await submitBillingRequest({
        request_type: "custom_dev",
        target_plan_code: summary.plan_code,
        billing_period: summary.billing_period || "monthly",
        amount_rub: 0,
        comment: comment,
      }, "Запрос на доработку отправлен");
    });
  }

    } catch (e) { /* письмо не должно ломать заявку */ }
  }

    var cover = objectCoverDisplayUrl(project);
    var active = num(project.id) === num(state.activeProjectId);
    var camera = String(project.camera_stream_url || "").trim();
    var address = [project.city, project.address].filter(function (value) {
      return String(value || "").trim();
    }).join(" · ");
    return '<div class="cab-object' + (active ? " is-active" : "") + '"' +
      ' data-cab-object="' + esc(project.id) + '"' +
      ' style="background-image:url(\'' + esc(cover) + '\');">' +
      '<div class="cab-object-shade"></div>' +
      '<div class="cab-object-body">' +
      (active ? '<span class="cab-active-flag">АКТИВНЫЙ ОБЪЕКТ</span>' : "") +
      '<div class="cab-object-title">' + esc(project.name || "Объект без названия") + "</div>" +
      '<div class="cab-object-sub">' + esc(address || "адрес не задан") + "</div>" +
      '<div class="cab-object-actions">' +
      '<button class="btn btn-glass btn-sm" data-cab-passport="' + esc(project.id) +
      '" type="button">Паспорт</button>' +
      '<button class="btn btn-glass btn-sm" data-cab-photos="' + esc(project.id) +
      '" type="button">Фотоотчёт</button>' +
      '<button class="btn btn-glass btn-sm" data-cab-camera="' + esc(project.id) +
      '" type="button"' + (camera ? "" : " disabled") + ">Камера</button>" +
      "</div></div></div>";
  }

  // ═════════ V194.5.5-C1 (ТЗ §1.4): объёмные плитки Кабинета ═════════
  // Иконки — инлайновый SVG (без внешних спрайтов): белая обводка, без заливки.

  /// Медальоны ИИ-плиток (правый верхний угол, 44×44).
  var AI_MEDAL_ICONS = {
    estimates: '<rect x="4" y="3" width="16" height="18" rx="2.6"/>' +
      '<path d="M8 8h8M8 12h8M8 16h4"/>',
    project: '<rect x="3.5" y="4" width="17" height="16" rx="1.8"/>' +
      '<path d="M3.5 9.5h17M9.5 4v16"/><path d="M13 20l7.5-7.5V20z"/>',
    contracts: '<path d="M12 3l7.2 3.1v5.6c0 4.1-2.9 7.3-7.2 9.3-4.3-2-7.2-5.2-7.2-9.3V6.1z"/>' +
      '<path d="M8.8 12.1l2.3 2.3 4.3-4.4"/>',
    rates: '<path d="M11.2 3.5h6.6a2.2 2.2 0 0 1 2.2 2.2v6.6L11.6 20.8 3.2 12.4z"/>' +
      '<path d="M15.4 7.6v5.2M13.8 9.1h3a1.3 1.3 0 0 1 0 2.6h-3M13.8 11.7h3.2"/>',
    // V194.5.6-B (ТЗ §2): карточка «Чертежи» — лист с рамкой и осевыми линиями.
    drawings: '<rect x="3.5" y="4" width="17" height="16" rx="1.6"/>' +
      '<path d="M3.5 8.5h17M3.5 15.5h17M8.6 4v16M15.4 4v16"/>' +
      '<path d="M5.8 6.2h1.4M16.8 17.8h1.4"/>'
  };

  function aiMedalHtml(kind) {
    return '<span class="ai-medal" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" focusable="false">' +
      (AI_MEDAL_ICONS[kind] || "") + "</svg></span>";
  }

  /// Бейджи нижних плиток (левый верхний угол, 38×38).
  var OPS_BADGE_ICONS = {
    gpr: '<path d="M4 19.5V4.5"/><path d="M4 19.5h16"/>' +
      '<path d="M7.5 15.5l3.6-3.9 3 2.9 4.4-5.2"/>',
    works: '<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4h4"/>' +
      '<path d="M9 13l2.2 2.2 4-4.2"/>',
    shifts: '<path d="M5.5 4.5h10a2 2 0 0 1 2 2v13h-10a2 2 0 0 1-2-2z"/>' +
      '<path d="M8.5 8.5h6.5M8.5 12h6.5M8.5 15.5h4"/>',
    finance: '<path d="M3.5 7.5h13a3 3 0 0 1 3 3v6a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2z"/>' +
      '<path d="M3.5 7.5l3-3.5h9"/><path d="M16.5 13.5h1.5"/>' +
      '<path d="M9 11v5M7.6 12.4h2.8M7.6 14.2h2.8"/>',
    team: '<circle cx="9" cy="8.5" r="3"/>' +
      '<path d="M3.5 20c0-3.2 2.5-5.6 5.5-5.6s5.5 2.4 5.5 5.6"/>' +
      '<circle cx="17.4" cy="10" r="2.3"/><path d="M15.6 20c0-2.4 1-4.2 2.5-5"/>',
    // V194.5.6-B (ТЗ §2): компактная плашка «База расценок компании».
    rates: '<path d="M11.2 3.5h6.6a2.2 2.2 0 0 1 2.2 2.2v6.6L11.6 20.8 3.2 12.4z"/>' +
      '<path d="M15.4 7.6v5.2M13.8 9.1h3a1.3 1.3 0 0 1 0 2.6h-3"/>'
  };

  function opsBadgeHtml(kind) {
    return '<span class="ops-badge" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" focusable="false">' +
      (OPS_BADGE_ICONS[kind] || "") + "</svg></span>";
  }

  function cabinetFloorsHtml(jobs, counts) {
    var projects = state.projects || [];
    var canEstimates = can("can_view_estimates") || canUseProjectCalc();
    var canProjectCalc = can("can_view_project_calc") || canUseProjectCalc();
    // V194.5.6-B (ТЗ §2): «Чертежи» — полноценная карточка ИИ-модулей (реестр
    // чертежей и ПТО-анализ), «База расценок» переехала в «Производство».
    var canDrawings = canProjectCalc || can("can_view_estimates");
    var canContracts = can("can_view_marketplace") || can("can_manage_users") || canUseProjectCalc();
    return "" +
      '<section class="cab-floor">' +
      '<div class="cab-floor-head"><h2 class="cab-floor-title">Объекты организации</h2>' +
      '<button class="btn btn-outline btn-sm" id="cab-object-new" type="button">+ Создать объект</button></div>' +
      (projects.length
        ? '<div class="cab-objects">' + projects.map(cabinetObjectCard).join("") + "</div>"
        : (state.projectsError
          ? '<div class="warn-box">' + esc(state.projectsError) +
            '<div class="small muted mt-8">Обратитесь к администратору организации: ' +
            "проверьте привязку объектов к организации.</div></div>"
          : '<div class="warn-box">Объектов пока нет — создайте первый, чтобы вести сметы, ГПР и смены.</div>')) +
      "</section>" +

      '<section class="cab-floor">' +
      '<div class="cab-floor-head"><h2 class="cab-floor-title">ИИ-модули</h2>' +
      '<span class="small muted">четыре контура платформы</span></div>' +
      '<div class="ai-tiles">' +
      (canEstimates
        ? '<a class="ai-tile ai-tile--sapphire" href="#/cabinet/estimates">' +
          aiMedalHtml("estimates") +
          '<span class="ai-badge">ИИ · АУДИТ СМЕТ</span>' +
          '<span class="ai-title">Сметы</span>' +
          '<span class="ai-note">Готово: ' + counts.jobsReady + " · в работе: " + counts.jobsActive + "</span>" +
          '<span class="ai-go">Открыть таблицу смет →</span></a>'
        : "") +
      (canProjectCalc
        ? '<a class="ai-tile ai-tile--emerald" href="#/cabinet/project">' +
          aiMedalHtml("project") +
          '<span class="ai-badge">ИИ · РАСЧЁТ ПД/РД</span>' +
          '<span class="ai-title">Расчёт объекта по ПД/РД</span>' +
          '<span class="ai-note">Томов в реестре: ' + counts.tomes + "</span>" +
          '<span class="ai-go">Открыть расчёт →</span></a>'
        : "") +
      (canContracts
        ? '<a class="ai-tile ai-tile--amethyst" href="#/cabinet/contractors">' +
          aiMedalHtml("contracts") +
          '<span class="ai-badge">ИИ · ЮРИСТ</span>' +
          '<span class="ai-title">Подрядчики и Договоры</span>' +
          '<span class="ai-note">База бригад · реестр договоров</span>' +
          '<span class="ai-go">Открыть реестр →</span></a>'
        : "") +
      (canDrawings
        ? '<a class="ai-tile ai-tile--steel" href="#/cabinet/drawings">' +
          aiMedalHtml("drawings") +
          '<span class="ai-badge">ИИ · ПТО</span>' +
          '<span class="ai-title">Чертежи</span>' +
          '<span class="ai-note">Загрузка, просмотр и ИИ-анализ чертежей объекта</span>' +
          '<span class="ai-go">Открыть реестр чертежей →</span></a>'
        : "") +
      "</div></section>";
  }


  function cabinetOpsTilesHtml(counts, canWorks, canShifts, canFinance, canTeam, activeName,
                               canRates) {
    var gprPercent = Math.max(0, Math.min(100, num(counts.gpr)));
    return '<section class="cab-floor">' +
      '<div class="cab-floor-head"><h2 class="cab-floor-title">Производство и управление</h2>' +
      '<span class="small muted">' + esc(activeName) + "</span></div>" +
      '<div class="ops-tiles">' +
      '<a class="ops-tile ops-tile--gpr" href="#/cabinet/gpr">' +
      '<span class="ops-head">' + opsBadgeHtml("gpr") +
      '<span class="ops-title">График ГПР</span></span>' +
      '<span class="ops-note">Выполнение: ' + num(counts.gpr) + "%</span>" +
      '<span class="ops-progress"><i style="width:' + gprPercent + '%"></i></span>' +
      '<span class="ops-arrow" aria-hidden="true">→</span></a>' +
      (canWorks
        ? '<a class="ops-tile ops-tile--works" href="#/cabinet/works">' +
          '<span class="ops-head">' + opsBadgeHtml("works") +
          '<span class="ops-title">Рабочая смета · КС-2/КС-3</span></span>' +
          '<span class="ops-note">Позиции, объёмы и акты по объекту</span>' +
          '<span class="ops-arrow" aria-hidden="true">→</span></a>'
        : "") +
      (canShifts
        ? '<a class="ops-tile ops-tile--shifts" href="#/cabinet/shifts">' +
          '<span class="ops-head">' + opsBadgeHtml("shifts") +
          '<span class="ops-title">Журнал смен (КС-6а)</span></span>' +
          '<span class="ops-note">Смен за 7 дней: ' + counts.shifts +
          " · сдать смену</span>" +
          '<span class="ops-arrow" aria-hidden="true">→</span></a>'
        : "") +
      (canFinance
        ? '<a class="ops-tile ops-tile--finance" href="#/cabinet/finance">' +
          '<span class="ops-head">' + opsBadgeHtml("finance") +
          '<span class="ops-title">Финансы</span></span>' +
          '<span class="ops-note">Приход/расход, счета и субсчёт</span>' +
          '<span class="ops-arrow" aria-hidden="true">→</span></a>'
        : "") +
      (canTeam
        ? '<a class="ops-tile ops-tile--team" href="#/cabinet/team">' +
          '<span class="ops-head">' + opsBadgeHtml("team") +
          '<span class="ops-title">Команда</span></span>' +
          '<span class="ops-note">Сотрудники, должности и права</span>' +
          '<span class="ops-arrow" aria-hidden="true">→</span></a>'
        : "") +
      // V194.5.6-B (ТЗ §2): «База расценок компании» — компактная плашка
      // в блоке «Производство и управление» рядом с «Командой».
      (canRates
        ? '<a class="ops-tile ops-tile--rates" href="#/cabinet/rates">' +
          '<span class="ops-head">' + opsBadgeHtml("rates") +
          '<span class="ops-title">База расценок компании</span></span>' +
          '<span class="ops-note">Тарифы компании для ИИ-расчётов</span>' +
          '<span class="ops-arrow" aria-hidden="true">→</span></a>'
        : "") +
      "</div></section>";
  }

  function cabinetSummaryHtml(counts) {
    return '<section class="cab-summary">' +
      '<div class="cab-sum"><span>Общий прогресс</span><strong>' + num(counts.gpr) + "%</strong></div>" +
      '<div class="cab-sum"><span>Смета</span><strong>' + money(counts.contract) + "</strong></div>" +
      '<div class="cab-sum"><span>Рыночная стоимость</span><strong>' + money(counts.market) + "</strong></div>" +
      '<div class="cab-sum"><span>Маржа</span><strong>' + pct(counts.margin) + "</strong></div>" +
      '<div class="cab-sum"><span>Чат (новые)</span><strong id="cab-chat-value">' +
      num(state.chatUnread) + "</strong></div></section>";
  }

  function renderCabinetShell(root, jobs, counts) {
    var project = activeProject();
    var activeName = project ? (project.name || "активный объект") : "объект не выбран";
    var canWorks = can("can_view_work_statement") || canUseProjectCalc();
    var canShifts = can("can_edit_gpr") || can("can_submit_reports") || canUseProjectCalc();
    var canFinance = can("can_view_finance_all") || can("can_view_subaccount") || canUseProjectCalc();
    var canTeam = can("can_manage_users") || state.isSuper;
    // V194.5.6-B (ТЗ §2): база расценок компании — плашка «Производства».
    var canRates = can("can_view_estimates") || canUseProjectCalc();
    root.innerHTML =
      '<div class="card cab-org-strip">' +
      '<div class="cab-org-main"><div class="small muted">Организация</div>' +
      '<div class="cab-org-name">' + esc(state.orgName || "Организация") + "</div>" +
      '<div class="small muted">' + esc(roleTitleJs()) + "</div></div>" +
      '<div class="cab-org-actions">' +
      '<button class="btn btn-outline btn-sm" id="cab-qr" type="button">QR-вход</button>' +
      '<label class="btn btn-navy" for="estimate-file" style="cursor:pointer;">' +
      "+ Загрузить смету / чертёж</label>" +
      '<input id="estimate-file" type="file" accept=".xlsx,.xlsm,.gsfx,.xml,.pdf" class="hidden" /></div>' +
      "</div>" +
      '<div class="card mt-16" id="cab-subscription"><div class="small muted">Загружаем тариф…</div></div>' +
      cabinetFloorsHtml(jobs, counts) +
      cabinetOpsTilesHtml(counts, canWorks, canShifts, canFinance, canTeam, activeName,
        canRates) +
      cabinetSummaryHtml(counts);

    var qrBtn = $("#cab-qr");
    if (qrBtn) qrBtn.addEventListener("click", openQrLogin);
    var createBtn = $("#cab-object-new");
    if (createBtn) createBtn.addEventListener("click", function () { openObjectEditor(null); });
    var fileInput = $("#estimate-file");
    if (fileInput) {
      fileInput.addEventListener("change", async function (event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        await uploadEstimate(file);
      });
    }
    $all("[data-cab-object]").forEach(function (node) {
      node.addEventListener("click", function (event) {
        if (event.target && event.target.closest && event.target.closest("button")) return;
        setActiveProject(node.getAttribute("data-cab-object"));
        renderRoute();
      });
    });
    $all("[data-cab-passport]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-cab-passport");
        setActiveProject(id);
        location.hash = "#/cabinet/object?id=" + encodeURIComponent(id);
      });
    });
    $all("[data-cab-photos]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-cab-photos");
        setActiveProject(id);
        location.hash = "#/cabinet/object?id=" + encodeURIComponent(id) + "&tab=photos";
      });
    });
    $all("[data-cab-camera]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = (state.projects || []).filter(function (item) {
          return String(item.id) === String(btn.getAttribute("data-cab-camera"));
        })[0];
        var url = String((row && row.camera_stream_url) || "").trim();
        if (!url) { toast("У этого объекта LIVE-камера не настроена"); return; }
        window.open(url, "_blank", "noopener");
      });
    });
  }


  /// Раздел «Сметы»: таблица смет и правка цен (открывается из плитки ИИ).
  async function renderEstimates(root) {
    root.innerHTML = '<div class="muted">Загрузка смет…</div>';
    if (!(await requireAuth(root))) return;
    try {
      var jobs = await cabinetJobs();
      state.cabinetJobs = jobs;
      root.innerHTML =
        '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Сметы</h2>' +
        '<p class="section-sub" style="margin:4px 0 0;">ИИ-аудит смет Контура А и Б, правка цен и Excel-отчёт.</p></div>' +
        '<label class="btn btn-navy" for="estimate-file" style="cursor:pointer;">' +
        "Загрузить смету (.xlsx / .gsfx / .pdf)</label>" +
        '<input id="estimate-file" type="file" accept=".xlsx,.xlsm,.gsfx,.xml,.pdf" class="hidden" /></div>' +
        '<div class="card mt-16" id="cabinet-jobs"></div>';
      renderJobsTable($("#cabinet-jobs"), jobs);
      var fileInput = $("#estimate-file");
      if (fileInput) {
        fileInput.addEventListener("change", async function (event) {
          var file = event.target.files && event.target.files[0];
          if (!file) return;
          await uploadEstimate(file);
        });
      }
    } catch (err) {
      root.innerHTML = '<div class="warn-box">Сметы не загрузились: ' +
        esc(err && err.message ? err.message : err) + "</div>";
    }
  }

  /// Раздел «График ГПР»: прогресс по этапам активного объекта.
  async function renderGpr(root) {
    root.innerHTML = '<div class="muted">Загрузка графика ГПР…</div>';
    if (!(await requireAuth(root))) return;
    try {
      if (!(state.projects || []).length) await loadProjectsList();
      var project = activeProject();
      var stages = [];
      if (project && state.orgId) {
        try {
          var res = await sb.from("gpr_stages").select("*")
            .eq("organization_id", state.orgId)
            .eq("project_id", num(project.id))
            .order("id");
          if (!res.error) stages = res.data || [];
        } catch (e) { stages = []; }
      }
      var plan = 0, fact = 0;
      stages.forEach(function (row) {
        plan += num(row.plan_volume);
        fact += num(row.fact_volume);
      });
      var total = plan > 0 ? Math.max(0, Math.min(100, Math.round((fact / plan) * 100))) : 0;
      var rowsHtml = stages.length
        ? stages.map(function (row) {
            var stagePlan = num(row.plan_volume);
            var percent = stagePlan > 0
              ? Math.max(0, Math.min(100, Math.round(num(row.fact_volume) / stagePlan * 100)))
              : 0;
            return "<tr><td><strong>" + esc(row.name || "Этап") + "</strong>" +
              '<div class="small muted">' + esc(row.dates || "") + "</div></td>" +
              "<td>" + esc(row.unit || "") + "</td>" +
              '<td class="num">' + num(row.plan_volume) + "</td>" +
              '<td class="num">' + num(row.fact_volume) + "</td>" +
              '<td class="num">' + percent + "%</td></tr>";
          }).join("")
        : '<tr><td colspan="5" class="muted">Этапов пока нет — ГПР ведётся в приложении НейроПлан.</td></tr>';
      root.innerHTML =
        objectSectionNav("gpr") +
        '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">График ГПР</h2>' +
        '<p class="section-sub" style="margin:4px 0 0;">' +
        esc(project ? (project.name || "объект") : "объект не выбран") +
        " · выполнение " + total + "%</p></div>" +
        '<a class="btn btn-outline btn-sm" href="#/cabinet/shifts">Сдать смену</a></div>' +
        '<div class="card mt-16"><div class="bar"><i style="width:' + total + '%"></i></div>' +
        '<div class="table-wrap mt-16"><table class="data"><thead><tr><th>Этап</th><th>Ед.</th>' +
        '<th class="num">План</th><th class="num">Факт</th><th class="num">%</th></tr></thead><tbody>' +
        rowsHtml + "</tbody></table></div></div>";
    } catch (err) {
      root.innerHTML = '<div class="warn-box">ГПР не загрузился: ' +
        esc(err && err.message ? err.message : err) + "</div>";
    }
  }


  // ═════════ V194.5.5-web (ТЗ §2.3): Журнал смен КС-6а — сдача смены с ноутбука ═════════

  async function loadProjectStages(projectId) {
    if (!projectId || !state.orgId) return [];
    try {
      var res = await sb.from("gpr_stages").select("*")
        .eq("organization_id", state.orgId)
        .eq("project_id", num(projectId))
        .order("id");
      if (res.error) return [];
      return res.data || [];
    } catch (e) {
      return [];
    }
  }

  async function loadStageWorks(projectId, stageId) {
    if (!projectId || !stageId || !state.orgId) return [];
    try {
      var res = await sb.from("work_statement_items").select("*")
        .eq("organization_id", state.orgId)
        .eq("project_id", num(projectId))
        .eq("gpr_stage_id", String(stageId))
        .eq("item_type", "work")
        .order("sort_order");
      if (res.error) return [];
      return res.data || [];
    } catch (e) {
      return [];
    }
  }

  function shiftWorksHtml(works) {
    if (!works.length) {
      return '<p class="small muted">По этому этапу нет позиций в Рабочей смете — ' +
        'загрузите смету или расчёт ПД/РД, затем вернитесь к сдаче смены.</p>';
    }
    return '<div class="shift-works">' + works.map(function (row) {
      var plan = num(row.plan_qty);
      var done = num(row.completed_qty);
      var remaining = Math.max(0, round2(plan - done));
      return '<label class="shift-work">' +
        '<input type="checkbox" data-shift-pick="' + esc(row.id) + '" />' +
        '<span class="shift-work-name"><strong>' + esc(row.name || "Работа") + "</strong>" +
        '<span class="small muted">План ' + plan + " " + esc(row.unit || "") +
        " · выполнено " + done + " " + esc(row.unit || "") + "</span></span>" +
        '<input type="number" step="0.001" min="0" class="shift-qty" data-shift-qty="' +
        esc(row.id) + '" value="' + remaining + '" disabled />' +
        "</label>";
    }).join("") + "</div>";
  }

  async function loadShiftWorksForStage(stageId) {
    var project = activeProject();
    var box = $("#shift-works");
    if (!box) return;
    box.innerHTML = '<div class="muted small">Загружаем работы этапа…</div>';
    state.shiftStageId = String(stageId || "");
    try {
      var works = await loadStageWorks(project ? num(project.id) : 0, stageId);
      state.shiftWorks = works;
      box.innerHTML = shiftWorksHtml(works);
      $all("[data-shift-pick]").forEach(function (checkbox) {
        checkbox.addEventListener("change", function () {
          var qty = document.querySelector('[data-shift-qty="' +
            checkbox.getAttribute("data-shift-pick") + '"]');
          if (qty) qty.disabled = !checkbox.checked;
        });
      });
    } catch (e) {
      state.shiftWorks = [];
      box.innerHTML = '<div class="warn-box">Работы этапа не загрузились: ' +
        esc(e && e.message ? e.message : e) + "</div>";
    }
  }


  async function submitShiftForm() {
    var project = activeProject();
    var stageId = String(($("#shift-stage") && $("#shift-stage").value) || "");
    var stage = (state.shiftStages || []).filter(function (row) {
      return String(row.id) === stageId;
    })[0] || null;
    var picks = [];
    $all("[data-shift-pick]").forEach(function (checkbox) {
      if (!checkbox.checked) return;
      var id = checkbox.getAttribute("data-shift-pick");
      var qtyNode = document.querySelector('[data-shift-qty="' + id + '"]');
      var qty = num(qtyNode && qtyNode.value);
      if (qty <= 0) return;
      var row = (state.shiftWorks || []).filter(function (item) {
        return String(item.id) === String(id);
      })[0];
      if (!row) return;
      picks.push({
        work_item_id: String(row.id),
        name: String(row.name || "Работа"),
        unit: String(row.unit || ""),
        qty: qty,
      });
    });
    if (!project) { toast("Сначала выберите активный объект"); return; }
    if (!stage) { toast("Выберите этап ГПР"); return; }
    if (!picks.length) { toast("Отметьте выполненные работы и объём"); return; }
    var fileNode = $("#shift-photo");
    var file = fileNode && fileNode.files && fileNode.files[0] ? fileNode.files[0] : null;
    if (!file) { toast("Приложите фото с площадки — без него смена не сдаётся"); return; }

    var button = $("#shift-submit");
    var statusNode = $("#shift-status");
    if (button) { button.disabled = true; button.textContent = "Сдаём смену…"; }
    if (statusNode) statusNode.textContent = "Загрузка фото в облако…";
    try {
      var stamp = new Date().toISOString();
      var path = state.orgId + "/" + num(project.id) + "/shift_" + Date.now() + "_" +
        sanitizeStorageKey(file.name || "shift.jpg");
      var up = await sb.storage.from("project_media").upload(path, file, {
        upsert: true, contentType: file.type || undefined,
      });
      if (up.error) throw up.error;
      var signed = await sb.storage.from("project_media")
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      var photoUrl = signed && !signed.error ? String(signed.data.signedUrl || "") : "";
      if (statusNode) statusNode.textContent = "Запись журнала смен…";

      var note = String(($("#shift-note") && $("#shift-note").value) || "").trim();
      var totalQty = picks.reduce(function (sum, item) { return sum + num(item.qty); }, 0);
      var description = "Смена по этапу «" + String(stage.name || "этап") + "»: " +
        picks.length + " поз., " + round2(totalQty) + " " + String(stage.unit || "");
      if (note) description += ". " + note;

      var reportRes = await sb.from("daily_reports").insert({
        project_id: num(project.id),
        organization_id: state.orgId,
        stage: String(stage.name || "Смена"),
        description: description,
        photo_path: path,
        timestamp: stamp,
        coordinates: "",
      });
      if (reportRes.error) throw reportRes.error;

      var shiftRes = await sb.from("shift_items").insert(picks.map(function (item) {
        return {
          organization_id: state.orgId,
          project_id: num(project.id),
          gpr_stage_id: String(stage.id),
          work_item_id: item.work_item_id,
          shift_date: stamp.slice(0, 10),
          shift_ref: stamp,
          name: item.name,
          unit: item.unit,
          qty: item.qty,
          photo_path: photoUrl || path,
          coordinates: "",
          note: note,
        };
      }));
      if (shiftRes.error) throw shiftRes.error;

      // «Выполнено» рабочей сметы: прирост строго по фактическим объёмам смены.
      for (var i = 0; i < picks.length; i++) {
        var pick = picks[i];
        var currentRes = await sb.from("work_statement_items")
          .select("completed_qty").eq("id", pick.work_item_id).limit(1);
        var current = currentRes && !currentRes.error && currentRes.data &&
          currentRes.data.length ? num(currentRes.data[0].completed_qty) : 0;
        await sb.from("work_statement_items")
          .update({ completed_qty: round2(current + num(pick.qty)) })
          .eq("id", pick.work_item_id);
      }
      if (statusNode) statusNode.textContent = "";
      toast("Смена сдана: " + picks.length + " поз., " + round2(totalQty) + " " +
        String(stage.unit || ""));
      renderRoute();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      if (statusNode) statusNode.textContent = "";
      toast("Смена не сдана: " + message, 8000);
    } finally {
      if (button) { button.disabled = false; button.textContent = "Сдать смену"; }
    }
  }


  async function renderShifts(root) {
    root.innerHTML = '<div class="muted">Загрузка журнала смен…</div>';
    if (!(await requireAuth(root))) return;
    try {
      if (!(state.projects || []).length) await loadProjectsList();
      var project = activeProject();
      if (!project) {
        root.innerHTML = '<div class="warn-box">Сначала создайте объект — смены ведутся по объекту.</div>' +
          '<button class="btn btn-navy mt-16" id="shift-new-object" type="button">+ Создать объект</button>';
        var createBtn = $("#shift-new-object");
        if (createBtn) createBtn.addEventListener("click", function () { openObjectEditor(null); });
        return;
      }
      var stages = await loadProjectStages(num(project.id));
      state.shiftStages = stages;
      var stageOptions = stages.length
        ? stages.map(function (row) {
            return '<option value="' + esc(row.id) + '">' + esc(row.name || "Этап") + "</option>";
          }).join("")
        : '<option value="">Этапы не найдены</option>';
      var since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      var shiftsRes = await sb.from("shift_items").select("*")
        .eq("organization_id", state.orgId)
        .eq("project_id", num(project.id))
        .gte("shift_date", since)
        .order("shift_date", { ascending: false })
        .limit(300);
      var shifts = shiftsRes && !shiftsRes.error ? (shiftsRes.data || []) : [];
      var groups = {};
      shifts.forEach(function (row) {
        var key = String(row.shift_date || "") + "|" + String(row.shift_ref || "");
        if (!groups[key]) groups[key] = [];
        groups[key].push(row);
      });
      var shiftRows = Object.keys(groups).map(function (key) {
        var rows = groups[key];
        var firstName = rows[0];
        var qty = rows.reduce(function (sum, row) { return sum + num(row.qty); }, 0);
        var units = {};
        rows.forEach(function (row) { units[String(row.unit || "")] = true; });
        return "<tr><td>" + esc(String(firstName.shift_date || "")) +
          '<div class="small muted">' + esc(String(firstName.shift_ref || "").slice(11, 19)) +
          "</div></td><td>" + rows.length + ' поз.</td><td class="num">' + round2(qty) + " " +
          esc(Object.keys(units).join("/")) + '</td><td class="small">' +
          esc(rows.map(function (row) { return row.name; }).join(", ").slice(0, 120)) +
          "</td></tr>";
      }).join("");
      root.innerHTML =
        '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Журнал смен (КС-6а)</h2>' +
        '<p class="section-sub" style="margin:4px 0 0;">' + esc(project.name || "объект") +
        " · сдача смены по позициям Рабочей сметы</p></div>" +
        '<button class="btn btn-outline btn-sm" id="shift-refresh" type="button">Обновить</button></div>' +
        '<div class="card mt-16"><h3>Сдать смену</h3>' +
        '<div class="form-row mt-8"><label class="field"><span>Этап ГПР</span>' +
        '<select id="shift-stage">' + stageOptions + "</select></label>" +
        '<label class="field"><span>Фото с площадки (обязательно)</span>' +
        '<input type="file" id="shift-photo" accept="image/*" /></label></div>' +
        '<label class="field mt-8"><span>Комментарий прораба</span>' +
        '<input type="text" id="shift-note" placeholder="Состав звена, техника, замечания" /></label>' +
        '<div id="shift-works" class="mt-8"></div>' +
        '<div class="flex mt-16"><button class="btn btn-navy" id="shift-submit" type="button">Сдать смену</button>' +
        '<span class="small muted" id="shift-status"></span></div></div>' +
        '<div class="card mt-16"><h3>Смены за 30 дней</h3>' +
        '<div class="table-wrap mt-8"><table class="data"><thead><tr><th>Дата</th><th>Позиций</th>' +
        '<th class="num">Объём</th><th>Работы</th></tr></thead><tbody>' +
        (shiftRows || '<tr><td colspan="4" class="muted">Смен пока нет — сдайте первую выше.</td></tr>') +
        "</tbody></table></div></div>";

      var stageSelect = $("#shift-stage");
      if (stageSelect) {
        stageSelect.addEventListener("change", function () {
          loadShiftWorksForStage(stageSelect.value);
        });
      }
      var submitBtn = $("#shift-submit");
      if (submitBtn) submitBtn.addEventListener("click", submitShiftForm);
      var refreshBtn = $("#shift-refresh");
      if (refreshBtn) refreshBtn.addEventListener("click", function () { renderRoute(); });
      if (stageSelect && stageSelect.value) {
        await loadShiftWorksForStage(stageSelect.value);
      } else if ($("#shift-works")) {
        $("#shift-works").innerHTML =
          '<p class="small muted">Этапов ГПР нет — создайте этапы в приложении НейроПлан.</p>';
      }
    } catch (err) {
      root.innerHTML = '<div class="warn-box">Журнал смен не загрузился: ' +
        esc(err && err.message ? err.message : err) + "</div>";
    }
  }

  function renderJobsTable(container, jobs) {
    if (!jobs.length) {
      container.innerHTML = '<h3>Смет пока нет</h3><p>Загрузите файл сметы — воркер посчитает Контур А и Контур Б и соберёт Excel.</p>';
      return;
    }
    var rows = jobs.map(function (job) {
      var summary = job.summary || {};
      var pom = summary.commercial_analysis || {};
      return "<tr><td><strong>" + esc(job.source_name || job.source_path || "смета") + "</strong>" +
        '<div class="small muted">' + esc((job.created_at || "").slice(0, 16).replace("T", " ")) + "</div></td>" +
        "<td>" + estimateStatusPill(job.status) + "</td>" +
        '<td class="num">' + money(job.contract_total || 0) + "</td>" +
        '<td class="num">' + money(job.market_total || 0) + "</td>" +
        '<td class="num">' + pct(jobMarginPercent(job)) + "</td>" +
        '<td><div class="flex"><button class="btn btn-outline btn-sm" data-report="' + esc(job.id) + '" data-path="' +
        esc(job.report_path || "") + '">Excel</button>' +
        '<button class="btn btn-outline btn-sm" data-prices="' + esc(job.id) + '">Правка цен</button>' +
        '<button class="btn btn-danger btn-sm" data-estimate-del="' + esc(job.id) +
        '">Удалить</button></div></td></tr>';
    }).join("");
    container.innerHTML =
      '<h3>Сметы</h3><div class="table-wrap mt-8"><table class="data"><thead><tr>' +
      "<th>Файл</th><th>Статус</th><th class=\"num\">Смета, ₽</th><th class=\"num\">Рынок, ₽</th>" +
      "<th class=\"num\">Маржа</th><th>Действия</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="small muted mt-8">«Правка цен» мгновенно пересчитывает итоги и Excel-отчёт ' +
      "без повторного запуска ИИ.</p>";

    $all("[data-report]", container).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var path = btn.getAttribute("data-path");
        if (!path) { toast("Отчёт ещё не сформирован"); return; }
        var signed = await sb.storage.from("estimates").createSignedUrl(path, 3600);
        if (signed.error) { toast("Не удалось получить ссылку: " + signed.error.message); return; }
        window.open(signed.data.signedUrl, "_blank");
      });
    });
    $all("[data-prices]", container).forEach(function (btn) {
      btn.addEventListener("click", function () { openPriceEditor(btn.getAttribute("data-prices")); });
    });
    $all("[data-estimate-del]", container).forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteEstimateJob(btn.getAttribute("data-estimate-del"));
      });
    });
  }

  /// V194.6.2 (ТЗ §5): удаление сметы из `estimate_jobs` вместе с файлами Storage.
  async function deleteEstimateJob(jobId) {
    var id = String(jobId || "");
    if (!id) return;
    if (!window.confirm("Удалить смету и её Excel-отчёт? Действие необратимо.")) return;
    var row = await sb.from("estimate_jobs")
      .select("id, organization_id, source_path, report_path")
      .eq("id", id).maybeSingle();
    if (row.error) { toast("Смета не найдена: " + row.error.message, 7000); return; }
    var paths = [row.data && row.data.source_path, row.data && row.data.report_path]
      .filter(function (path) { return !!path; });
    var del = await sb.from("estimate_jobs").delete().eq("id", id);
    if (del.error) {
      toast("Не удалось удалить смету: " + del.error.message, 9000);
      return;
    }
    if (paths.length) {
      try { await sb.storage.from("estimates").remove(paths); } catch (e) { /* файл мог быть удалён */ }
    }
    toast("Смета удалена");
    renderRoute();
  }

  async function uploadEstimate(file) {
    var orgId = state.orgId || 0;
    var path = (orgId > 0 ? orgId : "org") + "/" + Date.now() + "_" + file.name;
    toast("Загружаем смету…");
    var up = await sb.storage.from("estimates").upload(path, file, { upsert: true });
    if (up.error) { toast("Ошибка загрузки: " + up.error.message); return; }
    var ins = await sb.from("estimate_jobs").insert({
      status: "queued",
      source_path: path,
      source_name: file.name,
      organization_id: orgId > 0 ? orgId : null,
      user_id: state.userId,
      summary: {},
    }).select("id").maybeSingle();
    if (ins.error) { toast("Смета загружена, но заявка не создана: " + ins.error.message); return; }
    toast("Смета отправлена в очередь аудита");
    renderRoute();
  }

  async function openPriceEditor(jobId) {
    openModal("Правка цен · instant recalc_only", '<div class="muted">Читаем ведомость…</div>');
    var row = await sb.from("estimate_jobs").select("summary").eq("id", jobId).maybeSingle();
    var summary = (row.data && row.data.summary) || {};
    var supply = summary.supply || summary.market_supply || summary.positions || [];
    if (!Array.isArray(supply) || !supply.length) {
      $("#modal-body").innerHTML =
        '<div class="warn-box">В этой смете нет ведомости ресурсов для правки цен. ' +
        "Дождитесь завершения аудита или загрузите смету в формате ГРАНД-Сметы.</div>";
      return;
    }
    var items = supply.slice(0, 60);
    $("#modal-body").innerHTML =
      '<p class="small muted">Измените цену — сумма и Excel пересоберутся без вызова ИИ.</p>' +
      '<div class="table-wrap" style="max-height:46vh;overflow:auto;"><table class="data"><thead><tr>' +
      '<th>Позиция</th><th>Ед.</th><th class="num">Кол-во</th><th class="num">Цена, ₽</th></tr></thead><tbody>' +
      items.map(function (item, index) {
        var price = num(item.market_unit_price || item.unit_price || item.price);
        return "<tr><td>" + esc(item.name || item.title || "позиция") + "</td><td>" + esc(item.unit || "") +
          '</td><td class="num">' + qty(item.quantity || item.qty || 0) + "</td>" +
          '<td class="num"><input type="number" step="0.01" style="width:110px;text-align:right;" ' +
          'data-idx="' + index + '" value="' + (price || 0) + '" /></td></tr>';
      }).join("") +
      "</tbody></table></div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="patch-apply" type="button">Пересчитать без ИИ</button>' +
      '<span class="small muted">recalc_only · 1–2 секунды</span></div>';

    $("#patch-apply").addEventListener("click", async function () {
      var patches = [];
      $all("[data-idx]", $("#modal-body")).forEach(function (input) {
        var item = items[num(input.getAttribute("data-idx"))];
        var price = num(input.value);
        if (!item || price <= 0) return;
        var original = num(item.market_unit_price || item.unit_price || item.price);
        if (Math.abs(original - price) < 0.01) return;
        patches.push({ name: item.name || item.title, unit: item.unit || "", price: price });
      });
      if (!patches.length) { toast("Цены не изменены"); return; }
      var pending = Array.isArray(summary.price_patches) ? summary.price_patches.slice() : [];
      var nextSummary = Object.assign({}, summary, {
        recalc_only: true,
        price_patches: pending.concat(patches),
      });
      var upd = await sb.from("estimate_jobs")
        .update({ status: "queued", summary: nextSummary, error_message: null }).eq("id", jobId);
      if (upd.error) { toast("Не удалось поставить пересчёт: " + upd.error.message); return; }
      closeModal();
      toast("Пересчёт без ИИ запущен (" + patches.length + " поз.)");
      renderRoute();
    });
  }

  // ───────────────────────── База расценок компании ─────────────────────────
  async function renderRates(root) {
    root.innerHTML = '<div class="muted">Загрузка базы расценок…</div>';
    if (!(await requireAuth(root))) return;
    // V193.10: «Прайсы партнёров (Книга цен)» — только суперадминка.
    // Обычный пользователь не видит вкладку ни в UI, ни по прямому переходу.
    if (state.ratesTab === "partner") {
      if (!state.isSuper) {
        state.ratesTab = "base";
        root.innerHTML = '<div class="warn-box">Раздел «Прайсы партнёров (Книга цен)» доступен ' +
          'только владельцу платформы в суперадминке. <a href="#/cabinet/rates">К базе расценок</a></div>';
        return;
      }
      await renderPartnerPrices(root);
      return;
    }
    if (!state.isSuper && state.ratesTab === "partner") state.ratesTab = "base";
    // V194.6.2 (ТЗ §6): состав комплексной расценки (`included_works`).
    var RATE_COLUMNS = "id, region, category, work_name, unit, unit_price, rate_type, is_turnkey";
    var res = await sb.from("company_unit_rates")
      .select(RATE_COLUMNS + ", included_works")
      .order("work_name", { ascending: true }).limit(1000);
    if (res.error && /included_works/i.test(String(res.error.message || ""))) {
      // Миграция ещё не применена — база расценок остаётся доступной.
      res = await sb.from("company_unit_rates")
        .select(RATE_COLUMNS)
        .order("work_name", { ascending: true }).limit(1000);
    }
    var rows = res.data || [];
    if (res.error) {
      root.innerHTML = '<div class="warn-box">Не удалось прочитать базу расценок: ' +
        esc(res.error.message) + "</div>";
      return;
    }
    var byCategory = { Материалы: 0, Работы: 0, Механизмы: 0 };
    rows.forEach(function (row) { byCategory[row.category] = (byCategory[row.category] || 0) + 1; });

    root.innerHTML =
      ratesTabs("base") +
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">База расценок компании</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Чистые цены БЕЗ НДС. Именно отсюда расчёт объекта по ПД/РД берёт стоимость материалов, работ и техники.</p></div></div>' +
      '<div class="grid grid-4 mt-16">' +
      kpi("Материалы", String(byCategory["Материалы"] || 0), "позиций в базе") +
      kpi("Работы", String(byCategory["Работы"] || 0), "позиций в базе") +
      kpi("Механизмы", String(byCategory["Механизмы"] || 0), "смены техники") +
      kpi("Всего", String(rows.length), "строк расценок") +
      "</div>" +
      '<div class="card mt-16"><h3>Добавить расценку</h3>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Наименование</span><input type="text" id="rate-name" placeholder="Кладка газобетон D500" /></label>' +
      '<label class="field"><span>Единица</span><input type="text" id="rate-unit" placeholder="м3" /></label>' +
      '<label class="field"><span>Категория</span><select id="rate-category">' +
      "<option>Материалы</option><option>Работы</option><option>Механизмы</option></select></label>" +
      '<label class="field"><span>Цена без НДС, ₽</span><input type="number" step="0.01" id="rate-price" value="0" /></label>' +
      '<label class="field"><span>Регион</span><input type="text" id="rate-region" value="Общий" /></label>' +
      "</div>" +
      rateCompBoxHtml("rate-add-comp", "") +
      '<button class="btn btn-navy" id="rate-add" type="button">Добавить в базу</button></div>' +
      '<div class="card mt-16"><h3>Расценки организации</h3><div class="table-wrap mt-8" style="max-height:56vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Наименование</th><th>Категория</th><th>Ед.</th>' +
      '<th class="num">Цена без НДС, ₽</th><th>Регион</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(rateRow).join("") :
        '<tr><td colspan="6" class="muted">База пуста — добавьте первые расценки.</td></tr>') +
      "</tbody></table></div></div>";

    bindRatesTabs(root);
    $("#rate-add").addEventListener("click", async function () {
      var name = $("#rate-name").value.trim();
      var unit = $("#rate-unit").value.trim();
      var price = num($("#rate-price").value);
      if (!name || !unit || price <= 0) { toast("Заполните наименование, единицу и цену"); return; }
      var ins = await sb.from("company_unit_rates").insert({
        organization_id: state.orgId,
        region: $("#rate-region").value.trim() || "Общий",
        category: $("#rate-category").value,
        work_name: name,
        unit: unit,
        unit_price: price,
        rate_type: "work_only",
        vat_included: false,
        included_works: rateCompValue("rate-add-comp"),
      });
      if (ins.error) { toast("Ошибка добавления: " + ins.error.message); return; }
      toast("Расценка добавлена");
      renderRates(root);
    });

    $all("[data-rate-save]", root).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-rate-save");
        var input = $('[data-rate-price="' + id + '"]', root);
        var price = num(input.value);
        if (price <= 0) { toast("Цена должна быть больше нуля"); return; }
        var upd = await sb.from("company_unit_rates").update({ unit_price: price }).eq("id", id);
        if (upd.error) { toast("Ошибка сохранения: " + upd.error.message); return; }
        toast("Цена обновлена");
      });
    });
    $all("[data-rate-edit]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-rate-edit");
        var picked = rows.filter(function (item) {
          return String(item.id) === String(id);
        })[0];
        openRateEditModal(picked);
      });
    });
    $all("[data-rate-del]", root).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-rate-del");
        var del = await sb.from("company_unit_rates").delete().eq("id", id);
        if (del.error) { toast("Ошибка удаления: " + del.error.message); return; }
        toast("Расценка удалена");
        renderRates(root);
      });
    });
  }

  /// V194.6.2 (ТЗ §6): типовые операции состава комплексной расценки.
  var RATE_COMPOSITION_OPTIONS = ["Опалубка", "Армирование / вязка каркаса",
    "Бетонирование", "Гидроизоляция", "Утепление", "Монтаж"];

  function rateCompParts(value) {
    return String(value || "").split(/[,;]+/).map(function (part) {
      return part.trim();
    }).filter(function (part) { return !!part; });
  }

  /// Блок «Состав расценки (что включено)»: чекбоксы + произвольное примечание.
  function rateCompBoxHtml(scopeId, value) {
    var parts = rateCompParts(value);
    var picked = parts.map(function (part) { return part.toLowerCase(); });
    var note = parts.filter(function (part) {
      return RATE_COMPOSITION_OPTIONS.map(function (label) {
        return label.toLowerCase();
      }).indexOf(part.toLowerCase()) < 0;
    }).join(", ");
    return '<div class="rate-comp" id="' + esc(scopeId) + '">' +
      '<div class="rate-comp-title">Состав расценки (что включено)</div>' +
      '<div class="rate-comp-grid">' +
      RATE_COMPOSITION_OPTIONS.map(function (label) {
        var checked = picked.indexOf(label.toLowerCase()) >= 0;
        return '<label class="rate-comp-item"><input type="checkbox" data-rate-comp="' +
          esc(label) + '"' + (checked ? " checked" : "") + " /> <span>" +
          esc(label) + "</span></label>";
      }).join("") + "</div>" +
      '<input type="text" data-rate-comp-note placeholder="Дополнительный состав / примечание" ' +
      'value="' + esc(note) + '" /></div>';
  }

  function rateCompValue(scopeId) {
    var box = $("#" + scopeId);
    if (!box) return "";
    var picked = [];
    $all("[data-rate-comp]", box).forEach(function (input) {
      if (input.checked) picked.push(input.getAttribute("data-rate-comp"));
    });
    var note = String((box.querySelector("[data-rate-comp-note]") || {}).value || "").trim();
    if (note) picked.push(note);
    return picked.join(", ");
  }

  function rateRow(row) {
    var composition = rateCompParts(row.included_works);
    return "<tr><td><strong>" + esc(row.work_name) + "</strong>" +
      (composition.length
        ? '<div class="rate-comp-badge" title="' + esc(composition.join(", ")) + '">' +
          esc(composition.join(" · ")) + "</div>"
        : "") + "</td><td>" + esc(row.category) + "</td><td>" + esc(row.unit) +
      '</td><td class="num"><input type="number" step="0.01" style="width:120px;text-align:right;" data-rate-price="' +
      esc(row.id) + '" value="' + num(row.unit_price) + '" /></td><td>' + esc(row.region || "") + "</td>" +
      '<td><div class="flex" style="flex-wrap:wrap;">' +
      '<button class="btn btn-outline btn-sm" data-rate-save="' + esc(row.id) + '">Сохранить</button>' +
      '<button class="btn btn-outline btn-sm" data-rate-edit="' + esc(row.id) + '">Изменить</button>' +
      '<button class="btn btn-danger btn-sm" data-rate-del="' + esc(row.id) + '">Удалить</button>' +
      "</div></td></tr>";
  }

  /// V194.6.2 (ТЗ §6): редактирование всех полей расценки и её состава.
  function openRateEditModal(row) {
    if (!row) return;
    openModal("Изменить расценку",
      '<div class="form-row">' +
      '<label class="field"><span>Наименование</span><input type="text" id="rate-edit-name" value="' +
      esc(row.work_name || "") + '" /></label>' +
      '<label class="field"><span>Категория</span><select id="rate-edit-category">' +
      ["Материалы", "Работы", "Механизмы"].map(function (value) {
        return '<option value="' + value + '"' +
          (String(row.category || "") === value ? " selected" : "") + ">" + value + "</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Единица</span><input type="text" id="rate-edit-unit" value="' +
      esc(row.unit || "") + '" /></label>' +
      '<label class="field"><span>Цена без НДС, ₽</span><input type="number" step="0.01" ' +
      'id="rate-edit-price" value="' + num(row.unit_price) + '" /></label>' +
      '<label class="field"><span>Регион</span><input type="text" id="rate-edit-region" value="' +
      esc(row.region || "Общий") + '" /></label>' +
      "</div>" +
      rateCompBoxHtml("rate-edit-comp", row.included_works) +
      '<div class="small" id="rate-edit-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="rate-edit-save" type="button">' +
      "Сохранить</button>" +
      '<button class="btn btn-outline" id="rate-edit-cancel" type="button">Отмена</button></div>');
    $("#rate-edit-cancel").addEventListener("click", closeModal);
    $("#rate-edit-save").addEventListener("click", async function () {
      var name = String($("#rate-edit-name").value || "").trim();
      var unit = String($("#rate-edit-unit").value || "").trim();
      var price = num($("#rate-edit-price").value);
      var errorNode = $("#rate-edit-error");
      if (!name || !unit) {
        if (errorNode) errorNode.textContent = "Заполните наименование и единицу";
        return;
      }
      if (price <= 0) {
        if (errorNode) errorNode.textContent = "Цена должна быть больше нуля";
        return;
      }
      var patch = {
        work_name: name,
        category: $("#rate-edit-category").value,
        unit: unit,
        unit_price: price,
        region: String($("#rate-edit-region").value || "").trim() || "Общий",
        included_works: rateCompValue("rate-edit-comp"),
      };
      var upd = await sb.from("company_unit_rates").update(patch).eq("id", row.id);
      if (upd.error) {
        if (errorNode) errorNode.textContent = "Не сохранено: " + upd.error.message;
        return;
      }
      closeModal();
      toast("Расценка обновлена");
      renderRoute();
    });
  }

  // ───────────────────── Расчёт объекта по ПД/РД [PRO AI] ─────────────────────
  // V192.5 (Этап 3): единый реестр томов project_calc_tomes с привязкой к объекту.
  // Загрузка в Storage + реестр выполняются СРАЗУ при выборе файла (без запуска
  // расчёта); анализ запускается только по отмеченным чекбоксами томам.
  // Реестр общий: загрузил на ПК — видно на телефоне, и наоборот.
  function calcParamsDefaults() {
    return {
      materials_percent: 0, tooling_percent: 0, travel_rub: 0,
      travel_people: 0, travel_days: 0, travel_per_person_day: 0,
      overhead_percent: 0, profit_percent: 0, tax_mode: "none",
      // V194.5.4 (ТЗ §3.2): режим объёма работ ПТО по умолчанию — ПОЛНЫЙ
      // строительный цикл. Иначе «Работы / Техника / Общеплощадочные» = 0 ₽.
      calc_scope: "full_cycle",
      calc_scope_explicit: false,
    };
  }

  /// Подписи режимов ПТО (синхронно с приложением).
  var CALC_SCOPE_LABELS = {
    strict_spec: "Строго по спецификации проекта",
    full_cycle: "Полный строительный цикл (ИИ-ПТО)",
  };

  async function renderProjectCalc(root) {
    root.innerHTML = '<div class="muted">Загрузка расчётов…</div>';
    if (!(await requireAuth(root))) return;
    state.calcParams = Object.assign(calcParamsDefaults(), state.calcParams || {});
    state.selectedTomes = {};
    state.calcProjectId = 0;
    if (!(state.projects || []).length) await loadProjectsList();

    // V193.10.1: реестр томов организации + отдельная кнопка загрузки;
    // расчёт запускается только по выбранным томам (или папке/всем).
    root.innerHTML =
      '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Расчёт по ПД/РД</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Загрузите тома PDF/XLSX в папку объекта, ' +
      "отметьте нужные и запустите расчёт — получите ведомость, себестоимость и КП.</p></div>" +
      '<button class="btn btn-navy" id="pj-upload" type="button">+ Загрузить тома</button></div>' +
      '<div id="obj-switcher-slot" class="mt-16"></div>' +
      '<div class="card mt-16"><div class="flex-between">' +
      '<strong class="small" id="pj-tomes-count">Тома и папки организации</strong>' +
      '<button class="btn btn-outline btn-sm" id="pj-folder-add" type="button">+ Папка</button></div>' +
      '<div id="pj-tomes" class="mt-8"></div>' +
      '<div id="pj-tomes-actions"></div></div>' +
      '<div id="pj-cards" class="mt-16"></div>' +
      '<div id="pj-price-prompt" class="hidden"></div>' +
      '<div id="pj-progress" class="mt-8"></div><div id="pj-tabs" class="mt-8"></div>';

    var uploadBtn = $("#pj-upload");
    if (uploadBtn) uploadBtn.addEventListener("click", openCalcUploadModal);
    var folderBtn = $("#pj-folder-add");
    if (folderBtn) folderBtn.addEventListener("click", openCalcFolderModal);
    mountObjectSwitcher();
    wakeProjectWorker();
    await loadCalcProject(0);
  }

  /// Состояние объекта: последняя задача расчёта + реестр томов (ПК ↔ телефон).
  async function loadCalcProject(projectId) {
    // V193.3: расчёт живёт без объекта — последняя задача организации без project_id.
    state.calcProjectId = 0;
    state.calcJob = null;
    state.calcJobId = null;
    state.calcTomes = [];
    state.calcFolders = [];
    state.calcFolderId = "";
    state.calcCollapsedFolders = {};
    if (state.orgId) {
      var jobsRes = await sb.from("project_calc_jobs").select("*")
        .eq("org_id", state.orgId)
        .is("project_id", null)
        .order("created_at", { ascending: false }).limit(40);
      var jobs = jobsRes.data || [];
      // V193.9: список карточек расчётов (Master-Detail, как вкладка «Сметы»).
      state.calcJobs = jobs;
      // V194.5.4 (ТЗ §3.2): таблица и вкладки ведомости свёрнуты по умолчанию —
      // при входе во вкладку виден компактный список томов и готовых расчётов.
      state.calcJob = null;
      state.calcJobId = null;
      state.calcOpen = false;
      var first = jobs[0] || null;
      if (first && first.commercial_params) {
        state.calcParams = Object.assign(state.calcParams, first.commercial_params);
      }
    }
    renderCalcCards();
    renderProjectProgress();
    renderProjectTabs();
    subscribeCalcJob();
    await renderCalcTomes();
  }

  function calcJobById(jobId) {
    var jobs = Array.isArray(state.calcJobs) ? state.calcJobs : [];
    for (var i = 0; i < jobs.length; i++) {
      if (String(jobs[i].id) === String(jobId)) return jobs[i];
    }
    return null;
  }

  /// Открыть расчёт: карточки остаются сверху, ниже — 3 вкладки результата.
  async function openCalcJob(jobId) {
    var job = calcJobById(jobId);
    if (!job) return;
    state.calcJob = job;
    state.calcJobId = job.id;
    state.calcTab = "volumes";
    // V194.5.4 (ТЗ §3.2): «Открыть расчёт» разворачивает таблицу и вкладки.
    state.calcOpen = true;
    if (job.commercial_params) {
      state.calcParams = Object.assign(state.calcParams, job.commercial_params);
    }
    if (job.region) {
      state.calcParams = Object.assign({}, state.calcParams || {}, {
        region: String(job.region),
      });
    }
    subscribeCalcJob();
    renderProjectProgress();
    renderProjectTabs();
    var tabs = $("#pj-tabs");
    if (tabs && tabs.scrollIntoView) {
      tabs.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /// V194.5.4 (ТЗ §3.2): «Свернуть» — таблица и вкладки ведомости скрываются,
  /// остаётся компактный список томов и готовых расчётов.
  function collapseCalcJob() {
    state.calcOpen = false;
    renderCalcCards();
    renderProjectProgress();
    renderProjectTabs();
  }

  /// Предпросмотр тома: подписанный URL в модальном окне.
  async function previewCalcTome(tome) {
    if (!tome || !tome.path) { toast("У тома нет файла"); return; }
    var signed = await sb.storage.from(tome.bucket || "project_rd")
      .createSignedUrl(tome.path, 3600);
    if (signed.error) { toast("Не удалось открыть файл: " + signed.error.message); return; }
    var url = signed.data.signedUrl;
    var isPdf = String(tome.name || tome.label || "").toLowerCase().indexOf(".pdf") >= 0;
    openModal("Предпросмотр: " + (tome.name || tome.label || "том"),
      (isPdf
        ? '<iframe src="' + esc(url) +
          '" style="width:100%;height:70vh;border:0;border-radius:12px;"></iframe>'
        : '<div class="warn-box">Формат XLSX/CSV браузер не отображает — откройте файл отдельно.</div>') +
      '<div class="flex mt-16"><a class="btn btn-navy btn-sm" href="' + esc(url) +
      '" target="_blank" rel="noopener">Открыть в новой вкладке</a></div>');
  }

  async function openCalcJobTomes(jobId) {
    var job = calcJobById(jobId);
    var files = (job && Array.isArray(job.files_json)) ? job.files_json : [];
    if (!files.length) { toast("В заявке нет томов — загрузите PDF/XLSX", 6000); return; }
    if (files.length === 1) { previewCalcTome(files[0]); return; }
    openModal("Тома PDF (" + files.length + ")",
      '<div class="table-wrap" style="max-height:56vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Том</th><th>Папка</th><th></th></tr></thead><tbody>" +
      files.map(function (file, index) {
        return "<tr><td>" + esc(file.name || file.label || ("Том " + (index + 1))) +
          "</td><td>" + esc(file.folder || "Общие тома") +
          '</td><td><button class="btn btn-outline btn-sm" data-tome-preview="' + index +
          '" type="button">Открыть</button></td></tr>';
      }).join("") + "</tbody></table></div>");
    $all("[data-tome-preview]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        previewCalcTome(files[num(btn.getAttribute("data-tome-preview"))]);
      });
    });
  }

  async function openCalcJobDocs(jobId) {
    var job = calcJobById(jobId);
    if (!job) return;
    var volumes = job.volumes_json || {};
    var rowsCount = ((job.cost_model_json || {}).rows || []).length;
    if (String(job.status) !== "done" || volumes.priced !== true || rowsCount === 0) {
      toast("Документы ещё не сформированы: сначала нажмите «Рассчитать»", 6000);
      return;
    }
    // V194.6.2 (ТЗ §4): вместо трёх узких полосок — понятные карточки файлов.
    function docCard(badgeKind, badge, title, note, path) {
      var ready = String(path || "") !== "";
      return '<div class="doc-card">' +
        '<div class="doc-card-head">' +
        '<span class="doc-badge doc-badge--' + badgeKind + '">' + esc(badge) + "</span>" +
        "<strong>" + esc(title) + "</strong></div>" +
        '<p class="doc-card-note">' + esc(note) + "</p>" +
        '<button class="btn btn-navy btn-sm" data-doc="' + esc(path || "") +
        '" type="button"' + (ready ? "" : " disabled") + ">Скачать</button></div>";
    }
    openModal("Документы расчёта",
      '<div class="doc-cards">' +
      docCard("xlsx", "XLSX", "Финансовая модель",
        "Себестоимость, свод материалов, ведомость объёмов и калькулятор накруток",
        job.cost_xlsx_path) +
      docCard("xlsx", "XLSX", "Коммерческое предложение (таблица)",
        "Укрупнённая смета для заказчика с разбивкой Работа / Материалы",
        job.kp_xlsx_path) +
      docCard("docx", "DOCX", "Коммерческое предложение (документ)",
        "Готовый текстовый документ КП для отправки клиенту",
        job.kp_docx_path) +
      "</div>" +
      '<div class="flex mt-16"><button class="btn btn-outline" id="calc-docs-close" ' +
      'type="button">Закрыть</button></div>');
    var docsClose = $("#calc-docs-close");
    if (docsClose) docsClose.addEventListener("click", closeModal);
    $all("[data-doc]").forEach(function (btn) {
      btn.addEventListener("click", function () { openCalcDoc(btn.getAttribute("data-doc")); });
    });
  }

  async function deleteCalcJob(jobId) {
    if (!jobId) return;
    if (!window.confirm("Удалить расчёт? Тома останутся в реестре организации.")) return;
    var res = await sb.from("project_calc_jobs").delete().eq("id", jobId);
    // V193.10: ошибка RLS/сети больше не глотается — пользователь видит причину.
    if (res.error) {
      toast("Не удалось удалить расчёт: " + res.error.message, 9000);
      return;
    }
    try {
      await sb.from("project_calc_tomes").update({ job_id: null }).eq("job_id", jobId);
    } catch (e) { /* тома не критичны для удаления задачи */ }
    state.calcJobs = (Array.isArray(state.calcJobs) ? state.calcJobs : []).filter(function (job) {
      return String(job.id) !== String(jobId);
    });
    if (String(state.calcJobId) === String(jobId)) {
      state.calcJob = null;
      state.calcJobId = null;
      state.calcOpen = false;
    }
    toast("Расчёт удалён");
    renderCalcCards();
    renderProjectProgress();
    renderProjectTabs();
  }

  /// V193.9: карточки расчётов ПД/РД (статус, 2×2 показателей, 3 кнопки).
  function renderCalcCards() {
    var box = $("#pj-cards");
    if (!box) return;
    var jobs = Array.isArray(state.calcJobs) ? state.calcJobs : [];
    if (!jobs.length) { box.innerHTML = ""; return; }
    box.innerHTML = jobs.map(function (job) {
      var volumes = job.volumes_json || {};
      var atoms = Array.isArray(volumes.atoms) ? volumes.atoms.length : 0;
      var derived = Array.isArray(volumes.derived) ? volumes.derived.length : 0;
      var machinery = Array.isArray(volumes.machinery) ? volumes.machinery.length : 0;
      var services = Array.isArray(volumes.services) ? volumes.services.length : 0;
      var positions = atoms + derived + machinery + services;
      var costModel = job.cost_model_json || {};
      var cost = num((costModel.totals || {}).total_cost);
      var rowsCount = (costModel.rows || []).length;
      var priced = volumes.priced === true;
      var docsReady = String(job.status) === "done" && priced && rowsCount > 0 &&
        String(job.kp_xlsx_path || "").length > 0;
      var running = ["queued", "parsing", "pricing", "processing"].indexOf(String(job.status)) >= 0;
      var progress = job.progress_json || {};
      var percent = num(progress.percent) ||
        (num(progress.total) > 0 ? Math.round(num(progress.done) / num(progress.total) * 100) : 0);
      var badge = docsReady ? "Готово"
        : priced ? "Готово"
        : running ? (String(job.status) === "pricing" ? "Расчёт " + percent + "%" : "В работе " + percent + "%")
        : String(job.status) === "error" ? "Ошибка"
        : String(job.status) === "cancelled" ? "Отменён"
        : atoms ? "Объёмы готовы" : "В очереди";
      var cls = String(job.status) === "error" ? "bad"
        : String(job.status) === "cancelled" ? "off"
        : (docsReady || priced ? "ok" : "run");
      // V194.5.4 (ТЗ §3.2): показываем фактический режим, по умолчанию — полный цикл.
      var scope = String((job.commercial_params || {}).calc_scope || volumes.calc_scope || "full_cycle");
      var kpResult = (job.commercial_params || {}).__result__ || {};
      var kpTotal = num(kpResult.total);
      var files = Array.isArray(job.files_json) ? job.files_json.length : 0;
      var updated = String(job.updated_at || job.created_at || "").slice(0, 10);
      // Реальное имя: название задачи → имя файла тома (без безликих заглушек).
      var firstName = files && job.files_json && job.files_json[0]
        ? String(job.files_json[0].name || job.files_json[0].label || "") : "";
      var title = String(job.project_title || "").trim();
      if (!title || title === "Объект строительства" || title === "Расчёт по ПД/РД") {
        title = firstName.replace(/\.[^.]+$/, "") || "Расчёт по ПД/РД";
      }
      var amount = kpTotal > 0 ? money(kpTotal) : (cost > 0 ? money(cost) : "");
      // V194.5.4 (ТЗ §3.2): без дублирующих «₽» и «Excel / КП» — у расчёта
      // ровно четыре понятных действия, у готового — «Пересчитать стоимость»
      // и «Документы (.xlsx / .docx)».
      var actions = '<button class="btn btn-outline btn-sm" data-job-tomes="' +
        esc(job.id) + '" type="button">PDF</button>';
      if (docsReady) {
        actions += '<button class="btn btn-navy btn-sm" data-job-docs="' + esc(job.id) +
          '" type="button">Документы (.xlsx / .docx)</button>' +
          '<button class="btn btn-outline btn-sm" data-job-price="' + esc(job.id) +
          '" type="button">Пересчитать стоимость</button>';
      } else {
        actions += '<button class="btn btn-navy btn-sm" data-job-price="' + esc(job.id) +
          '" type="button"' + (running || !atoms ? " disabled" : "") +
          '>Рассчитать</button>';
      }
      actions += '<button class="btn btn-outline btn-sm" data-job-del="' +
        esc(job.id) + '" type="button">Удалить</button>';
      var openLabel = (state.calcJobId && String(state.calcJobId) === String(job.id) &&
        state.calcOpen) ? "Свернуть" : "Открыть расчёт";
      return '<div class="calc-row is-' + cls + '" data-job="' + esc(job.id) + '">' +
        '<div class="cr-icon">' + (String(job.status) === "error" ? "!" :
          (running ? "⏳" : (docsReady ? "✓" : "📄"))) + "</div>" +
        '<div class="cr-main" data-job-open="' + esc(job.id) + '" style="cursor:pointer;">' +
        '<div class="cr-title">' + esc(title) + "</div>" +
        '<div class="cr-sub">' + esc(updated + " · " + files + " том(ов)") +
        (scope === "full_cycle" ? " · ИИ-ПТО" : "") + "</div></div>" +
        '<div class="cr-right">' + pill(badge, cls === "bad" ? "bad" : (cls === "ok" ? "ok" : "info")) +
        (amount ? '<span class="cr-sum">' + amount + "</span>" : "") +
        actions +
        '<button class="btn btn-outline btn-sm" data-job-open-btn="' + esc(job.id) +
        '" type="button">' + openLabel + "</button>" +
        "</div></div>";
    }).join("");
    $all("[data-job-open]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { openCalcJob(btn.getAttribute("data-job-open")); });
    });
    $all("[data-job-open-btn]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var jobId = btn.getAttribute("data-job-open-btn");
        if (state.calcOpen && String(state.calcJobId) === String(jobId)) {
          collapseCalcJob();
        } else {
          openCalcJob(jobId);
        }
      });
    });
    $all("[data-job-tomes]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { openCalcJobTomes(btn.getAttribute("data-job-tomes")); });
    });
    $all("[data-job-docs]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { openCalcJobDocs(btn.getAttribute("data-job-docs")); });
    });
    $all("[data-job-price]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { requestCalcPricing(btn.getAttribute("data-job-price")); });
    });
    $all("[data-job-del]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { deleteCalcJob(btn.getAttribute("data-job-del")); });
    });
  }

  // V192.0 (ТЗ §4): мгновенное пробуждение проектного воркера (fire-and-forget).
  // Render spin-down: первый входящий запрос поднимает контейнер, и задача из
  // очереди project_calc_jobs подхватывается сразу после старта. Ответ не нужен,
  // поэтому mode: "no-cors" — ошибки глушим, постановку задачи они не ломают.
  function wakeProjectWorker() {
    var base = String(CFG.projectWorkerUrl || "").trim().replace(/\/+$/, "");
    if (!base) return;
    try {
      fetch(base + "/health", {
        mode: "no-cors",
        cache: "no-store",
        keepalive: true,
      }).catch(function () { /* контейнер ещё спит — дожмёт keep-alive пинг */ });
    } catch (e) { /* fire-and-forget: пробуждение не влияет на заявку */ }
  }

  // V192.4 (Этап 2): ключ объекта Storage — только латиница/цифры/«_»/«-»/«.».
  // Оригинальное русское имя остаётся в БД (file_name / title), а не в пути.
  function sanitizeStorageKey(name) {
    var raw = String(name || "").trim();
    var dot = raw.lastIndexOf(".");
    var base = dot > 0 ? raw.slice(0, dot) : raw;
    var ext = dot > 0 ? raw.slice(dot + 1) : "";
    var map = {
      "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
      "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
      "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
      "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
      "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    };
    var slug = base.toLowerCase().split("").map(function (ch) {
      return map[ch] !== undefined ? map[ch] : ch;
    }).join("");
    slug = slug.replace(/[^a-z0-9._-]+/g, "_").replace(/_+/g, "_")
      .replace(/^[_\-.]|[_\-.]+$/g, "");
    if (!slug) slug = "tome";
    var cleanExt = ext.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return cleanExt ? slug + "." + cleanExt : slug;
  }

  /// V193.10.1: ASCII-ключ Storage `<uuid>.<ext>` — кириллица, пробелы и скобки
  /// остаются только в БД (file_name/title) и больше не ломают загрузку.
  function tomeStorageKey(name) {
    var raw = String(name || "").trim();
    var dot = raw.lastIndexOf(".");
    var ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
    if (!ext) ext = "bin";
    var hex = "";
    try {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) {
        hex += ("0" + bytes[i].toString(16)).slice(-2);
      }
    } catch (e) {
      hex = (Date.now().toString(16) + Math.random().toString(16).slice(2, 10)).slice(0, 32);
    }
    return hex + "." + ext;
  }

  function calcSpinner(text) {
    var node = $("#pj-spinner");
    if (!node) return;
    if (!text) { node.classList.add("hidden"); node.textContent = ""; return; }
    node.classList.remove("hidden");
    node.innerHTML = '<span class="pill pill-info">' + esc(text) + "</span>";
  }


  /// V193.3: загрузка томов без привязки к объекту (сразу в список расчёта).
  async function uploadCalcTomes(fileList, options) {
    var opts = options || {};
    var silent = opts.silent === true;
    if (!fileList || !fileList.length) return 0;
    if (!state.orgId) {
      toast("Организация не определена — перезайдите в аккаунт");
      return 0;
    }
    var files = Array.prototype.slice.call(fileList);
    // Папка по умолчанию создаётся до загрузки, чтобы тома не «повисали» без папки.
    if (!state.calcFolderId) {
      await loadCalcFolders(0);
    }
    calcSpinner("Загрузка томов: " + files.length + "…");
    var folder = state.orgId + "/calc/free/" + Date.now();
    var rows = [];
    var errors = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      // Транслитерация ключа: русские имена в Storage ломают подпись/скачивание.
      var path = folder + "/" + (i + 1) + "_" + tomeStorageKey(file.name);
      var up = await sb.storage.from("project_rd")
        .upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (up.error) {
        // V193.10.1: ошибка Storage проговаривается вслух и копится для итога.
        console.error("[calc upload] Storage", file.name, up.error);
        errors.push(file.name + ": " + up.error.message);
        continue;
      }
      rows.push({
        project_id: null,
        org_id: state.orgId,
        user_id: state.userId,
        bucket: "project_rd",
        storage_path: path,
        folder_id: state.calcFolderId || null,
        // Оригинальное русское имя хранится в БД, ключ Storage — латиница.
        file_name: file.name,
        title: String(file.name.replace(/\.[^.]+$/, "")).slice(0, 200),
        mime_type: file.type || "",
        size_bytes: file.size || 0,
      });
    }
    calcSpinner("");
    if (!rows.length) {
      toast(errors.length
        ? "Не удалось загрузить: " + errors[0]
        : "Файлы не выбраны", 9000);
      return { added: 0, errors: errors };
    }
    var ins = await sb.from("project_calc_tomes").insert(rows);
    if (ins.error) {
      console.error("[calc upload] register", ins.error);
      toast("Файлы загружены, но реестр не обновлён: " + ins.error.message, 9000);
      return { added: 0, errors: errors.concat([ins.error.message]) };
    }
    if (!silent) {
      toast("Томов добавлено: " + rows.length);
      var titleNode = $("#pj-new-title");
      if (titleNode && !titleNode.value.trim() && files.length === 1) {
        titleNode.value = String(files[0].name.replace(/\.[^.]+$/, "")).slice(0, 200);
      }
    }
    if (!silent) {
      await renderCalcTomes();
      toast(errors.length
        ? "Томов добавлено: " + rows.length + ", ошибок: " + errors.length +
          " (" + errors[0] + ")"
        : "Томов добавлено: " + rows.length, errors.length ? 9000 : 5000);
    }
    return { added: rows.length, errors: errors };
  }

  function updateCalcStartLabel() {
    var btn = $("#pj-start");
    if (!btn) return;
    var count = Object.keys(state.selectedTomes || {}).length;
    if (count > 0) {
      btn.textContent = "Разобрать объёмы выбранных томов (" + count + ")";
      return;
    }
    if (state.calcFolderId) {
      var folderCount = (state.calcTomes || []).filter(function (tome) {
        return String(tome.folder_id || "") === String(state.calcFolderId);
      }).length;
      if (folderCount > 0) {
        btn.textContent = "Разобрать объёмы папки «" + calcFolderName(state.calcFolderId) + "» (" + folderCount + ")";
        return;
      }
    }
    btn.textContent = "Разобрать объёмы всех томов (" + (state.calcTomes || []).length + ")";
  }

  /// V193.3: папки расчёта живут на уровне организации (без привязки к объекту).
  async function loadCalcFolders(projectId) {
    state.calcFolders = [];
    if (!state.orgId) return [];
    var res = await sb.from("project_calc_folders").select("*")
      .eq("org_id", state.orgId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (res.error) {
      console.warn("[calc folders]", res.error.message);
      return [];
    }
    var folders = res.data || [];
    if (!folders.length) {
      var ins = await sb.from("project_calc_folders").insert({
        project_id: null,
        org_id: state.orgId,
        name: "Общие тома",
        sort_order: 0,
      }).select().maybeSingle();
      if (ins.data) folders = [ins.data];
    }
    state.calcFolders = folders;
    var known = folders.some(function (folder) {
      return String(folder.id) === String(state.calcFolderId || "");
    });
    if (!known) state.calcFolderId = folders.length ? String(folders[0].id) : "";
    var label = $("#pj-folder-name");
    if (label) label.textContent = calcFolderName(state.calcFolderId);
    return folders;
  }

  function calcFolderName(folderId) {
    var hit = (state.calcFolders || []).filter(function (folder) {
      return String(folder.id) === String(folderId || "");
    })[0];
    return hit ? hit.name : "Общие тома";
  }

  function openCalcFolderModal() {
    if (!state.orgId) { toast("Организация не определена — перезайдите в аккаунт"); return; }
    openModal("Новая папка томов",
      '<label class="field"><span>Название папки</span>' +
      '<input type="text" id="cf-name" placeholder="Секция 1 МКД" /></label>' +
      '<div class="flex mt-8">' +
      ["Секция 1 МКД", "Секция 2 МКД", "Паркинг", "Наружные сети"].map(function (preset) {
        return '<button class="btn btn-outline btn-sm" data-preset="' + esc(preset) +
          '" type="button">' + esc(preset) + "</button>";
      }).join("") + "</div>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="cf-create" type="button">Создать</button></div>');
    $all("[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var input = $("#cf-name");
        if (input) input.value = btn.getAttribute("data-preset");
      });
    });
    var createBtn = $("#cf-create");
    if (createBtn) createBtn.addEventListener("click", async function () {
      var name = String(($("#cf-name") && $("#cf-name").value) || "").trim();
      if (!name) { toast("Укажите название папки"); return; }
      var ins = await sb.from("project_calc_folders").insert({
        project_id: null,
        org_id: state.orgId || null,
        name: name,
        sort_order: Math.floor(Date.now() / 1000) % 1000000,
      }).select().maybeSingle();
      if (ins.error) { toast("Папка не создана: " + ins.error.message, 7000); return; }
      if (ins.data) state.calcFolderId = String(ins.data.id);
      closeModal();
      toast("Папка создана: " + name);
      await renderCalcTomes();
    });
  }

  async function moveCalcTome(tomeId) {
    var folders = state.calcFolders || [];
    if (!folders.length) { toast("Сначала создайте папку"); return; }
    var body = folders.map(function (folder) {
      return '<button class="btn btn-outline btn-sm mt-8" data-move-to="' + esc(folder.id) +
        '" type="button">' + esc(folder.name) + "</button>";
    }).join("");
    openModal("Переместить том", '<div class="flex" style="flex-wrap:wrap;gap:8px;">' + body + "</div>");
    $all("[data-move-to]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var upd = await sb.from("project_calc_tomes")
          .update({ folder_id: btn.getAttribute("data-move-to") }).eq("id", tomeId);
        if (upd.error) { toast("Не перемещено: " + upd.error.message, 7000); return; }
        closeModal();
        toast("Том перемещён в папку «" + calcFolderName(btn.getAttribute("data-move-to")) + "»");
        await renderCalcTomes();
      });
    });
  }

  /// V193.10.1: панель действий по выбранным томам.
  function updateCalcSelectionBar() {
    var box = $("#pj-tomes-actions");
    if (!box) return;
    var selected = (state.calcTomes || []).filter(function (tome) {
      return state.selectedTomes && state.selectedTomes[tome.id];
    });
    if (!selected.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="calc-run mt-8">' +
      '<button class="btn btn-navy" id="pj-run-selected" type="button">Рассчитать выбранные (' +
      selected.length + ")</button>" +
      '<button class="btn btn-outline" id="pj-move-selected" type="button">В папку</button>' +
      '<button class="btn btn-danger" id="pj-del-selected" type="button">Удалить</button></div>';
    var runBtn = $("#pj-run-selected");
    if (runBtn) runBtn.addEventListener("click", function () {
      openCalcRunModal(selected, "выбранные тома");
    });
    var moveBtn = $("#pj-move-selected");
    if (moveBtn) moveBtn.addEventListener("click", function () { batchMoveTomes(selected); });
    var delBtn = $("#pj-del-selected");
    if (delBtn) delBtn.addEventListener("click", function () { batchDeleteTomes(selected); });
  }

  /// «+ Загрузить тома»: папка + файлы, БЕЗ запуска расчёта.
  function openCalcUploadModal() {
    if (!state.orgId) { toast("Организация не определена — перезайдите в аккаунт"); return; }
    var folders = state.calcFolders || [];
    var options = folders.map(function (folder) {
      return '<option value="' + esc(folder.id) + '">' + esc(folder.name) + "</option>";
    }).join("");
    openModal("Загрузить тома",
      '<p class="small muted">Файлы попадут в общий реестр организации. Расчёт запускается ' +
      "отдельно — по выбранным томам.</p>" +
      '<label class="field"><span>Папка объекта</span><select id="up-folder">' +
      (options || '<option value="">Общие тома</option>') + "</select></label>" +
      '<label class="field"><span>Файлы PDF/XLSX</span>' +
      '<input type="file" id="up-files" multiple accept=".pdf,.xlsx,.xlsm,.csv" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="up-go" type="button">Загрузить</button>' +
      '<button class="btn btn-outline btn-sm" id="up-folder-new" type="button">+ Новая папка</button>' +
      '<span class="small muted">Расчёт не запускается автоматически</span></div>');
    var newFolderBtn = $("#up-folder-new");
    if (newFolderBtn) {
      newFolderBtn.addEventListener("click", function () {
        closeModal();
        openCalcFolderModal();
      });
    }
    var goBtn = $("#up-go");
    if (goBtn) {
      goBtn.addEventListener("click", async function () {
        var input = $("#up-files");
        var files = input && input.files ? input.files : null;
        if (!files || !files.length) { toast("Выберите файлы PDF/XLSX", 6000); return; }
        var folderSelect = $("#up-folder");
        state.calcFolderId = folderSelect ? String(folderSelect.value || "") : "";
        goBtn.disabled = true;
        goBtn.textContent = "Загрузка…";
        var result = await uploadCalcTomes(files);
        closeModal();
        await renderCalcTomes();
        if (result && result.added) {
          toast("Томов добавлено: " + result.added +
            ". Отметьте нужные и нажмите «Рассчитать выбранные»", 8000);
        }
      });
    }
  }

  /// Окно запуска расчёта: регион + режим ПТО.
  function openCalcRunModal(tomes, scopeLabel) {
    var list = tomes || [];
    if (!list.length) { toast("Нет томов для расчёта"); return; }
    openModal("Рассчитать: " + scopeLabel,
      '<p class="small muted">Томов в задаче: ' + list.length +
      ". Разбор идёт в фоновом воркере, результат появится в карточке расчёта.</p>" +
      '<label class="field"><span>Регион (обязателен для цен на этапе 2)</span>' +
      '<input type="text" id="run-region" value="' +
      esc((state.calcParams && state.calcParams.region) || "") +
      '" placeholder="Краснодарский край" /></label>' +
      '<label class="field"><span>Режим объёма работ</span><select id="run-scope">' +
      '<option value="full_cycle">Полный строительный цикл (ИИ-ПТО)</option>' +
      '<option value="strict_spec">Строго по спецификации проекта</option></select></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="run-go" type="button">' +
      "Разобрать объёмы</button></div>");
    var scopeSelect = $("#run-scope");
    if (scopeSelect) {
      scopeSelect.value = (state.calcParams && state.calcParams.calc_scope === "strict_spec")
        ? "strict_spec" : "full_cycle";
    }
    var goBtn = $("#run-go");
    if (goBtn) {
      goBtn.addEventListener("click", function () {
        var regionField = $("#run-region");
        var region = String((regionField && regionField.value) || "").trim();
        state.calcParams = Object.assign({}, state.calcParams || {}, {
          region: region,
          calc_scope: scopeSelect ? scopeSelect.value : "full_cycle",
          // V194.5.4: метка явного выбора — без неё воркер считает полный цикл.
          calc_scope_explicit: !!(scopeSelect && scopeSelect.value === "strict_spec"),
        });
        closeModal();
        startCalcJob(list, scopeLabel);
      });
    }
  }

  /// Массовое удаление выбранных томов (Storage + реестр), с явными ошибками.
  async function batchDeleteTomes(tomes) {
    var list = tomes || [];
    if (!list.length) return;
    if (!window.confirm("Удалить томов: " + list.length +
        "? Файлы удаляются из Storage безвозвратно.")) return;
    var errors = [];
    for (var i = 0; i < list.length; i++) {
      var tome = list[i];
      var rem = await sb.storage.from(tome.bucket || "project_rd")
        .remove([tome.storage_path]);
      if (rem.error) {
        errors.push((tome.file_name || tome.title || "том") + ": " + rem.error.message);
      }
      var del = await sb.from("project_calc_tomes").delete().eq("id", tome.id);
      if (del.error) {
        errors.push((tome.file_name || tome.title || "том") + ": " + del.error.message);
      }
      if (state.selectedTomes) delete state.selectedTomes[tome.id];
    }
    toast(errors.length ? "Не всё удалено: " + errors[0] : "Удалено томов: " + list.length, 9000);
    await renderCalcTomes();
  }

  /// Объединение выбранных томов в одну папку.
  async function batchMoveTomes(tomes) {
    var list = tomes || [];
    if (!list.length) return;
    var folders = state.calcFolders || [];
    if (!folders.length) { toast("Сначала создайте папку"); return; }
    var body = folders.map(function (folder) {
      return '<button class="btn btn-outline btn-sm mt-8" data-move-batch="' +
        esc(folder.id) + '" type="button">' + esc(folder.name) + "</button>";
    }).join("");
    openModal("В папку: " + list.length + " том(ов)",
      '<div class="flex" style="flex-wrap:wrap;gap:8px;">' + body + "</div>");
    $all("[data-move-batch]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var folderId = btn.getAttribute("data-move-batch");
        var upd = await sb.from("project_calc_tomes")
          .update({ folder_id: folderId })
          .in("id", list.map(function (tome) { return tome.id; }));
        if (upd.error) { toast("Не перемещено: " + upd.error.message, 9000); return; }
        closeModal();
        toast("Томов перемещено: " + list.length);
        state.selectedTomes = {};
        await renderCalcTomes();
      });
    });
  }

  /// V193.6: компактная строка тома (≈50 px) вместо белой карточки на файл:
  /// чекбокс · имя + размер/статус · иконки «в папку» и «удалить».
  function calcTomeRow(tome) {
    var checked = state.selectedTomes && state.selectedTomes[tome.id] ? " checked" : "";
    var kb = Math.round(num(tome.size_bytes) / 1024);
    var size = kb >= 1024 ? (kb / 1024).toFixed(1) + " МБ" : kb + " КБ";
    var meta = [size];
    if (tome.job_id) meta.push("рассчитан");
    return '<div class="tome-row' + (checked ? " is-selected" : "") + '">' +
      '<input type="checkbox" class="tome-check" data-tome-check="' +
      esc(tome.id) + '"' + checked + " />" +
      '<div class="tome-main"><span class="tome-name">' +
      esc(tome.file_name || tome.title || "том") + "</span>" +
      '<span class="tome-meta">' + esc(meta.join(" · ")) + "</span></div>" +
      '<button class="icon-act" data-tome-open="' + esc(tome.id) +
      '" type="button" title="Открыть PDF">👁</button>' +
      '<button class="icon-act" data-tome-run="' + esc(tome.id) +
      '" type="button" title="Рассчитать этот том">▶</button>' +
      '<button class="icon-act" data-tome-move="' + esc(tome.id) +
      '" type="button" title="Переместить в папку">📁</button>' +
      '<button class="icon-act is-danger" data-tome-del="' + esc(tome.id) +
      '" type="button" title="Удалить">🗑</button>' +
      "</div>";
  }

  /// Список томов объекта, сгруппированный по папкам (секциям), с чекбоксами.
  async function renderCalcTomes() {
    var box = $("#pj-tomes");
    if (!box) return;
    if (!state.orgId) {
      box.innerHTML = '<p class="small muted">Организация не определена — перезайдите в аккаунт.</p>';
      updateCalcStartLabel();
      return;
    }
    var folders = await loadCalcFolders(0);
    var res = await sb.from("project_calc_tomes").select("*")
      .eq("org_id", state.orgId)
      .order("created_at", { ascending: true });
    if (res.error) {
      box.innerHTML = '<div class="warn-box">Реестр томов недоступен: ' + esc(res.error.message) + "</div>";
      updateCalcStartLabel();
      return;
    }
    var tomes = res.data || [];
    state.calcTomes = tomes;
    // V193.2: пустой реестр — старая ошибка удалённого тома не должна висеть.
    if (!tomes.length && state.calcJob &&
        (state.calcJob.status === "error" || state.calcJob.status === "cancelled")) {
      autoResetCalcJob(state.calcJob.id);
      state.calcJob = null;
      state.calcJobId = null;
      renderProjectProgress();
    }
    var countNode = $("#pj-tomes-count");
    if (countNode) {
      countNode.textContent = tomes.length
        ? "всего: " + tomes.length + " · папок: " + folders.length
        : "";
    }
    renderCalcFolderSelect(folders);
    if (!tomes.length) {
      box.innerHTML = '<p class="small muted">Томов пока нет: нажмите «+ Загрузить тома» (PDF/XLSX) — список появится здесь.</p>';
      updateCalcStartLabel();
      return;
    }
    // V193.6: компактные строки томов и папок — без громоздких белых карточек.
    var collapsed = state.calcCollapsedFolders || (state.calcCollapsedFolders = {});
    var html = "";
    folders.forEach(function (folder) {
      var folderId = String(folder.id);
      var list = tomes.filter(function (tome) {
        return String(tome.folder_id || "") === folderId;
      });
      var isCollapsed = !!collapsed[folderId];
      var isActive = String(state.calcFolderId || "") === folderId;
      html += '<div class="folder-row' + (isActive ? " is-active" : "") + '">' +
        '<button class="folder-toggle" data-folder-toggle="' + esc(folderId) + '" type="button">' +
        '<span class="folder-caret">' + (isCollapsed ? "▸" : "▾") + "</span>" +
        '<span class="folder-name">📁 ' + esc(folder.name) + " (" + list.length + ")</span></button>" +
        '<button class="folder-pick" data-folder-select="' + esc(folderId) + '" type="button">' +
        (isActive ? "выбрана ✓" : "выбрать") + "</button></div>";
      if (!isCollapsed) {
        html += list.length
          ? list.map(function (tome) { return calcTomeRow(tome); }).join("")
          : '<div class="tome-empty">В папке нет томов — загрузите PDF/XLSX в эту папку.</div>';
      }
    });
    // V193.1: тома без папки не теряются — видимая секция «Без папки».
    var knownFolderIds = {};
    folders.forEach(function (folder) { knownFolderIds[String(folder.id)] = true; });
    var orphans = tomes.filter(function (tome) {
      return !knownFolderIds[String(tome.folder_id || "")];
    });
    if (orphans.length) {
      html += '<div class="folder-row is-orphan"><span class="folder-name">📁 Без папки (' +
        orphans.length + ")</span><span class=\"small muted\">переместите в папку</span></div>" +
        orphans.map(function (tome) { return calcTomeRow(tome); }).join("");
    }
    box.innerHTML = html;
    updateCalcSelectionBar();

    function pick(attr) {
      return tomes.filter(function (t) { return String(t.id) === attr; })[0];
    }
    $all("[data-folder-toggle]", box).forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.getAttribute("data-folder-toggle");
        collapsed[id] = !collapsed[id];
        renderCalcTomes();
      });
    });
    $all("[data-folder-select]", box).forEach(function (el) {
      el.addEventListener("click", function () {
        state.calcFolderId = el.getAttribute("data-folder-select");
        var label = $("#pj-folder-name");
        if (label) label.textContent = calcFolderName(state.calcFolderId);
        renderCalcTomes();
      });
    });
    $all("[data-tome-move]", box).forEach(function (el) {
      el.addEventListener("click", function () { moveCalcTome(el.getAttribute("data-tome-move")); });
    });
    $all("[data-tome-check]", box).forEach(function (el) {
      el.addEventListener("change", function () {
        var id = el.getAttribute("data-tome-check");
        if (!state.selectedTomes) state.selectedTomes = {};
        if (el.checked) state.selectedTomes[id] = true;
        else delete state.selectedTomes[id];
        var row = el.closest(".tome-row");
        if (row) row.classList.toggle("is-selected", !!el.checked);
        updateCalcStartLabel();
        updateCalcSelectionBar();
      });
    });
    $all("[data-tome-open]", box).forEach(function (el) {
      el.addEventListener("click", function () { openCalcTome(pick(el.getAttribute("data-tome-open"))); });
    });
    $all("[data-tome-draw]", box).forEach(function (el) {
      el.addEventListener("click", function () { promoteTomeToDrawings(pick(el.getAttribute("data-tome-draw"))); });
    });
    $all("[data-tome-del]", box).forEach(function (el) {
      el.addEventListener("click", function () { deleteCalcTome(pick(el.getAttribute("data-tome-del"))); });
    });
    $all("[data-tome-run]", box).forEach(function (el) {
      el.addEventListener("click", function () {
        var tome = pick(el.getAttribute("data-tome-run"));
        if (tome) {
          openCalcRunModal([tome], "том «" + (tome.file_name || tome.title || "том") + "»");
        }
      });
    });
    updateCalcStartLabel();
  }


  /// Выбор папки, в которую уйдёт следующая загрузка томов.
  function renderCalcFolderSelect(folders) {
    var select = $("#pj-folder");
    if (!select) return;
    select.innerHTML = (folders || []).map(function (folder) {
      return '<option value="' + esc(folder.id) + '"' +
        (String(folder.id) === String(state.calcFolderId || "") ? " selected" : "") +
        ">" + esc(folder.name) + "</option>";
    }).join("");
    if (!select.innerHTML) {
      select.innerHTML = '<option value="">Общие тома</option>';
    }
  }

  /// V193.3: одна кнопка «Рассчитать»: выбранные тома → папка → все тома.
  async function startCalcSmart() {
    var selected = (state.calcTomes || []).filter(function (t) {
      return state.selectedTomes && state.selectedTomes[t.id];
    });
    if (selected.length) {
      openCalcRunModal(selected, "выбранные тома");
      return;
    }
    var all = state.calcTomes || [];
    if (!all.length) {
      toast("Сначала загрузите тома PDF/XLSX");
      return;
    }
    if (state.calcFolderId) {
      var inFolder = all.filter(function (tome) {
        return String(tome.folder_id || "") === String(state.calcFolderId);
      });
      if (inFolder.length) {
        openCalcRunModal(inFolder, "папка «" + calcFolderName(state.calcFolderId) + "»");
        return;
      }
    }
    openCalcRunModal(all, "все тома");
  }

  /// Постановка задачи в очередь project_calc_jobs (без привязки к объекту).
  async function startCalcJob(tomes, scopeLabel) {
    var selected = tomes || [];
    if (!selected.length) {
      toast("Нет томов для расчёта");
      return;
    }
    if (!state.orgId) {
      toast("Организация не определена — перезайдите в аккаунт");
      return;
    }
    wakeProjectWorker();
    var btn = $("#pj-start");
    if (btn) { btn.disabled = true; btn.textContent = "Создание задачи…"; }
    calcSpinner("Создание задачи…");
    var titleInput = "";
    var title = titleInput ||
      String(selected[0].file_name || selected[0].title || "Расчёт по ПД/РД")
        .replace(/\.[^.]+$/, "");
    var ins = await sb.from("project_calc_jobs").insert({
      org_id: state.orgId,
      user_id: state.userId,
      project_id: null,
      project_title: title.slice(0, 200),
      region: String((state.calcParams && state.calcParams.region) || "").trim(),
      sections_count: 1,
      floors_count: 1,
      total_area_m2: 0,
      status: "queued",
      files_json: selected.map(function (tome) {
        return {
          name: tome.file_name || tome.title || "том",
          path: tome.storage_path,
          bucket: tome.bucket || "project_rd",
          label: tome.title || tome.file_name || "том",
          folder: calcFolderName(tome.folder_id),
          folder_id: tome.folder_id || "",
        };
      }),
      commercial_params: Object.assign({}, calcParamsDefaults(), state.calcParams || {}, {
        scope_label: scopeLabel,
        // V193.9: режим объёма работ по умолчанию — строго по спецификации.
        calc_scope: (state.calcParams && state.calcParams.calc_scope === "strict_spec")
          ? "strict_spec" : "full_cycle",
        // V193.7: этап 1 — только ведомость объёмов, без рыночных цен.
        mode: "volumes_only",
      }),
      progress_json: { line: "заявка создана", done: 0, total: selected.length },
    }).select().maybeSingle();
    calcSpinner("");
    if (btn) {
      btn.disabled = false;
      updateCalcStartLabel();
    }
    if (ins.error) {
      toast("Не удалось создать заявку: " + ins.error.message, 7000);
      return;
    }
    state.calcJob = ins.data;
    state.calcJobId = ins.data.id;
    // V193.9: новый расчёт сразу появляется карточкой в списке.
    state.calcJobs = [ins.data].concat(Array.isArray(state.calcJobs) ? state.calcJobs : []);
    state.calcTab = "volumes";
    renderCalcCards();
    var ids = selected.map(function (tome) { return tome.id; });
    await sb.from("project_calc_tomes").update({ job_id: state.calcJobId }).in("id", ids);
    state.selectedTomes = {};
    // Задача уже в очереди — повторный пинг гарантирует, что воркер не спит.
    wakeProjectWorker();
    toast("Расчёт поставлен в очередь (" + scopeLabel + ", томов: " + selected.length + ")");
    subscribeCalcJob();
    renderProjectProgress();
    renderProjectTabs();
    await renderCalcTomes();
  }


  async function openCalcTome(tome) {
    if (!tome) return;
    var signed = await sb.storage.from(tome.bucket || "project_rd")
      .createSignedUrl(tome.storage_path, 3600);
    if (signed.error) { toast("Не удалось открыть файл: " + signed.error.message); return; }
    window.open(signed.data.signedUrl, "_blank");
  }

  /// Привязка тома к разделу «Чертежи» без дублирования файла в Storage.
  async function promoteTomeToDrawings(tome) {
    if (!tome) return;
    if (tome.drawing_id) { toast("Том уже связан с разделом «Чертежи»"); return; }
    var projectId = num(state.calcProjectId) || num(state.calcJob && state.calcJob.project_id);
    if (!projectId) {
      toast("Выберите объект раздела «Чертежи» в форме расчёта");
      return;
    }
    var ins = await sb.from("project_drawings").insert({
      project_id: projectId,
      organization_id: state.orgId || null,
      code: String(tome.title || tome.file_name || "ПД").slice(0, 40),
      title: String(tome.file_name || tome.title || "Том ПД/РД").slice(0, 200),
      section: "ПР",
      status: "В производстве работ",
      file_path: tome.storage_path,
    }).select("id").maybeSingle();
    if (ins.error) { toast("Не удалось привязать к «Чертежам»: " + ins.error.message); return; }
    await sb.from("project_calc_tomes").update({ drawing_id: ins.data.id }).eq("id", tome.id);
    toast("Том добавлен в раздел «Чертежи» (файл не дублируется)");
    await renderCalcTomes();
  }

  async function deleteCalcTome(tome) {
    if (!tome) return;
    var removed = await sb.storage.from(tome.bucket || "project_rd").remove([tome.storage_path]);
    if (removed.error) toast("Файл не удалён: " + removed.error.message);
    var del = await sb.from("project_calc_tomes").delete().eq("id", tome.id);
    if (del.error) { toast("Не удалось удалить том: " + del.error.message); return; }
    if (state.selectedTomes) delete state.selectedTomes[tome.id];
    // V193.3: удаление тома гасит старую ошибку расчёта — таймаут не всплывает.
    if (state.calcJob && (state.calcJob.status === "error" || state.calcJob.status === "cancelled")) {
      await autoResetCalcJob(state.calcJob.id);
      state.calcJob = null;
      state.calcJobId = null;
      subscribeCalcJob();
      renderProjectProgress();
      renderProjectTabs();
    }
    toast("Том удалён");
    await renderCalcTomes();
  }


  /// V192.4 (Этап 2): выбор готовых томов из раздела «Чертежи» (облако, с поиском).
  /// V192.5: выбранные чертежи попадают в реестр томов объекта, расчёт не стартует.
  async function openDrawingsPicker() {
    var projectId = num(state.calcProjectId) || num(state.calcJob && state.calcJob.project_id);
    if (!projectId) { toast("Сначала выберите объект в форме расчёта"); return; }
    openModal("Выбрать из Чертежей", '<div class="muted">Загрузка чертежей объекта…</div>');
    var res = await sb.from("project_drawings")
      .select("id, code, title, section, file_path, date")
      .eq("project_id", projectId).order("created_at", { ascending: false }).limit(300);
    if (res.error) {
      $("#modal-body").innerHTML =
        '<div class="warn-box">Не удалось прочитать «Чертежи»: ' + esc(res.error.message) + "</div>";
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      $("#modal-body").innerHTML =
        '<div class="warn-box">В разделе «Чертежи» этого объекта пока нет документов.</div>';
      return;
    }
    $("#modal-body").innerHTML =
      '<label class="field"><span>Поиск по шифру или названию</span>' +
      '<input type="text" id="dw-search" placeholder="КЖ, АР, план этажа…" /></label>' +
      '<div class="table-wrap" style="max-height:46vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th></th><th>Шифр</th><th>Наименование</th><th>Раздел</th><th>Файл</th>" +
      '</tr></thead><tbody id="dw-rows">' + rows.map(function (row) {
        var hasFile = String(row.file_path || "").trim().length > 0;
        return '<tr data-text="' +
          esc(((row.code || "") + " " + (row.title || "") + " " + (row.section || "")).toLowerCase()) + '">' +
          '<td><input type="checkbox" data-dw="' + esc(row.id) + '"' + (hasFile ? "" : " disabled") + " /></td>" +
          "<td>" + esc(row.code || "") + "</td>" +
          "<td>" + esc(row.title || "") + "</td>" +
          "<td>" + esc(row.section || "") + "</td>" +
          '<td class="small">' + (hasFile ? esc(row.file_path) :
            '<span class="pill pill-warn">нет файла</span>') + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="dw-add" type="button">Добавить в реестр томов</button>' +
      '<span class="small muted">Файл копируется в бакет расчёта один раз</span></div>';

    var search = $("#dw-search");
    if (search) {
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        $all("#dw-rows tr").forEach(function (tr) {
          tr.style.display = !q || tr.getAttribute("data-text").indexOf(q) >= 0 ? "" : "none";
        });
      });
    }
    var addBtn = $("#dw-add");
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        var ids = $all("[data-dw]:checked").map(function (el) {
          return el.getAttribute("data-dw");
        });
        if (!ids.length) { toast("Отметьте хотя бы один документ"); return; }
        addDrawingsAsTomes(rows.filter(function (row) {
          return ids.indexOf(String(row.id)) >= 0;
        }));
      });
    }
  }

  /// V192.5: выбранные «Чертежи» копируются в бакет расчёта один раз и сразу
  /// попадают в общий реестр томов объекта (расчёт при этом НЕ запускается).
  async function addDrawingsAsTomes(rows) {
    var projectId = num(state.calcProjectId) || num(state.calcJob && state.calcJob.project_id);
    if (!projectId) { toast("Сначала выберите объект в форме расчёта"); return; }
    var folder = state.orgId + "/calc/" + projectId + "/" + Date.now() + "_drawings";
    var uploaded = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var source = String(row.file_path || "").trim();
      if (!source || /^https?:/i.test(source)) {
        toast("«" + (row.title || row.code) +
          "»: файла нет в Storage — добавьте его в «Чертежи» заново", 6000);
        continue;
      }
      var safeName = sanitizeStorageKey(source.split("/").pop() || (row.code || "doc"));
      var target = folder + "/" + (i + 1) + "_" + safeName;
      var dl = await sb.storage.from("stroyka-files").download(source);
      if (dl.error) {
        toast("Не удалось скачать «" + (row.title || row.code) + "»: " + dl.error.message, 6000);
        continue;
      }
      var up = await sb.storage.from("project_rd").upload(target, dl.data, { upsert: true });
      if (up.error) {
        toast("Не удалось скопировать «" + (row.title || row.code) + "»: " + up.error.message, 6000);
        continue;
      }
      uploaded.push({
        project_id: projectId,
        org_id: state.orgId || null,
        user_id: state.userId,
        bucket: "project_rd",
        storage_path: target,
        folder_id: state.calcFolderId || null,
        file_name: (row.title || row.code || safeName) + "." + (safeName.split(".").pop() || "pdf"),
        title: String(row.code || row.title || safeName).slice(0, 200),
        mime_type: (dl.data && dl.data.type) || "",
        size_bytes: (dl.data && dl.data.size) || 0,
      });
    }
    if (!uploaded.length) return;
    var ins = await sb.from("project_calc_tomes").insert(uploaded);
    if (ins.error) {
      toast("Файлы скопированы, но реестр не обновлён: " + ins.error.message, 7000);
    } else {
      toast("Добавлено томов в реестр: " + uploaded.length);
    }
    closeModal();
    await renderCalcTomes();
  }



  function subscribeCalcJob() {
    if (state.calcChannel) {
      try { sb.removeChannel(state.calcChannel); } catch (e) { /* канал уже закрыт */ }
      state.calcChannel = null;
    }
    if (!state.calcJobId) return;
    try {
      state.calcChannel = sb.channel("pj-" + state.calcJobId)
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: "project_calc_jobs",
          filter: "id=eq." + state.calcJobId,
        }, function (payload) {
          if (payload && payload.new) {
            state.calcJob = payload.new;
            var cp = payload.new.commercial_params || {};
            // V193.9: параметры (включая calc_scope) синхронизируются с карточкой.
            if (cp && typeof cp === "object") {
              state.calcParams = Object.assign({}, calcParamsDefaults(),
                state.calcParams, cp);
            }
            var list = Array.isArray(state.calcJobs) ? state.calcJobs : [];
            var replaced = false;
            for (var i = 0; i < list.length; i++) {
              if (String(list[i].id) === String(payload.new.id)) {
                list[i] = payload.new; replaced = true; break;
              }
            }
            if (!replaced && list.length) list.unshift(payload.new);
            renderCalcCards();
            renderProjectProgress();
            renderProjectTabs();
          }
        })
        .subscribe();
    } catch (e) { /* статус обновляется кнопкой */ }
  }

  /// V193.4: компактная полоска «что считается сейчас» — прямо над кнопкой
  /// «Рассчитать». Список томов и папок при этом остаётся на экране, даже если
  /// расчёт идёт (queued/parsing/pricing): отдельного окна «Реестр томов» нет.
  function renderCalcNowStrip() {
    var box = $("#pj-now");
    if (!box) return;
    var job = state.calcJob;
    var running = job && ["queued", "parsing", "pricing", "processing"]
      .indexOf(String(job.status)) >= 0;
    if (!running) {
      box.innerHTML = "";
      return;
    }
    var progress = job.progress_json || {};
    var done = num(progress.done), total = num(progress.total);
    var percent = num(progress.percent) > 0
      ? Math.min(100, Math.round(num(progress.percent)))
      : (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);
    var line = String(progress.line || "ожидание освобождения воркера");
    box.innerHTML = '<div class="calc-now">' +
      '<span class="pill pill-info">' + (percent > 0 ? percent + "%" : "…") + "</span>" +
      '<span class="calc-now-line">' + esc(line) + "</span>" +
      '<span class="bar"><i style="width:' + (percent > 0 ? percent : 6) + '%"></i></span>' +
      "</div>";
  }

  /// V193.7: плашка «Объёмы определены (N позиций). Рассчитать стоимость?».
  function renderPricePrompt() {
    var box = $("#pj-price-prompt");
    if (!box) return;
    var job = state.calcJob;
    var volumes = (job && job.volumes_json) || {};
    var atoms = Array.isArray(volumes.atoms) ? volumes.atoms : [];
    if (!job || !atoms.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    var costModel = job.cost_model_json || {};
    var priced = costModel && Object.keys(costModel).length > 0;
    var running = ["queued", "parsing", "pricing", "processing"]
      .indexOf(String(job.status)) >= 0;
    box.classList.remove("hidden");
    box.innerHTML = '<div class="price-prompt">' +
      '<div class="price-prompt-head"><span class="price-prompt-dot">✓</span>' +
      "Объёмы определены (" + atoms.length + " позиций)</div>" +
      '<div class="price-prompt-note">' + (priced
        ? "Стоимость посчитана. Сменили регион или расценки — пересчитайте без повторного разбора PDF."
        : "Рассчитать стоимость по базе компании и рыночным ценам региона? Повторный разбор томов не нужен.") +
      "</div>" +
      '<button class="btn btn-primary btn-sm" id="pj-price-go" type="button"' +
      (running ? " disabled" : "") + ">" +
      (priced ? "Пересчитать стоимость" : "Рассчитать стоимость") + "</button></div>";
    var btn = $("#pj-price-go");
    if (btn) {
      btn.addEventListener("click", function () { requestCalcPricing(job.id); });
    }
  }

  /// V193.7: этап 2 — «Рассчитать стоимость» по сохранённой ведомости объёмов.
  async function requestCalcPricing(jobId) {
    if (!jobId) return;
    var job = calcJobById(jobId) || state.calcJob || {};
    var region = String(
      (state.calcParams && state.calcParams.region) || job.region || "").trim();
    // V193.9: регион — обязательное условие рыночных цен.
    if (!region) {
      region = String(window.prompt(
        "Регион строительства (обязателен для рыночных цен):", "") || "").trim();
      if (!region) {
        toast("Без региона рыночные цены не ищутся — расчёт стоимости не запущен", 7000);
        return;
      }
      if (regionInput) regionInput.value = region;
    }
    var params = Object.assign({}, job.commercial_params || {}, state.calcParams || {}, {
      mode: "price_only",
      __result__: null,
      // V194.5.4 (ТЗ §3.2): «Рассчитать стоимость» не залипает на старом
      // strict_spec — по умолчанию полный строительный цикл.
      calc_scope: (state.calcParams && state.calcParams.calc_scope) || "full_cycle",
      calc_scope_explicit: !!(state.calcParams && state.calcParams.calc_scope_explicit),
      region: region,
    });
    var res = await sb.from("project_calc_jobs").update({
      status: "queued",
      error_message: null,
      region: region,
      commercial_params: params,
      progress_json: {
        line: "расчёт стоимости поставлен в очередь",
        done: 0, total: 1, percent: 0,
      },
    }).eq("id", jobId);
    if (res.error) {
      toast("Не удалось запустить расчёт стоимости: " + res.error.message, 7000);
      return;
    }
    state.calcJobId = jobId;
    state.calcJob = Object.assign({}, job, { status: "queued", region: region });
    toast("Стоимость считается по готовой ведомости объёмов (" + region + ")");
    wakeProjectWorker();
    subscribeCalcJob();
    renderCalcCards();
    renderProjectProgress();
    renderProjectTabs();
  }

  function renderProjectProgress() {
    var box = $("#pj-progress");
    // V193.4: полоска над «Разобрать объёмы» синхронизирована с той же задачей.
    renderCalcNowStrip();
    // V193.7: плашка «Объёмы определены — рассчитать стоимость?».
    renderPricePrompt();
    if (!box) return;
    var job = state.calcJob;
    if (!job) {
      box.innerHTML = '<div class="warn-box">Расчётов пока нет. Загрузите тома ПД/РД для разбора объёмов.</div>';
      return;
    }
    // V194.5.4 (ТЗ §3.2): детальный прогресс раскрывается только кнопкой
    // «Открыть расчёт» — при входе во вкладку виден компактный список.
    if (!state.calcOpen) { box.innerHTML = ""; return; }
    var progress = job.progress_json || {};
    var done = num(progress.done), total = num(progress.total);
    var percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    // V192.9: задача «зависла», если воркер давно не обновлял строку.
    var updatedTs = Date.parse(String(job.updated_at || ""));
    var stuckMinutes = Number.isFinite(updatedTs)
      ? Math.floor((Date.now() - updatedTs) / 60000) : 0;
    var isRunning = ["queued", "parsing", "pricing", "processing"].indexOf(String(job.status)) >= 0;
    var isStuck = isRunning && stuckMinutes >= 10;
    // V193.9: документы доступны только когда расчёт завершён, ведомость
    // оценена и в себестоимости есть строки (никаких пустых файлов).
    var costRows = ((job.cost_model_json || {}).rows || []).length;
    var docsReady = job.status === "done" &&
      (job.volumes_json || {}).priced === true && costRows > 0 &&
      String(job.kp_xlsx_path || "").length > 0;
    box.innerHTML =
      '<div class="card"><div class="flex-between"><h3 style="margin:0;">' + esc(job.project_title || "Объект") + "</h3>" +
      pill(job.status === "done" ? "Расчёт готов" : job.status === "error" ? "Ошибка" : "В работе",
        job.status === "done" ? "ok" : job.status === "error" ? "bad" : "info") + "</div>" +
      '<p class="small muted mt-8">' + esc(progress.line || "ожидание") + "</p>" +
      '<div class="bar mt-8"><i style="width:' + percent + '%"></i></div>' +
      (isStuck
        ? '<div class="warn-box mt-8">Расчёт не отвечает ' + stuckMinutes +
          " мин. Обычно это перезапуск воркера на Render — нажмите «Повторить расчёт».</div>"
        : "") +
      (job.error_message ? '<div class="warn-box mt-8">' + esc(job.error_message) + "</div>" : "") +
      (job.status === "error" && !job.error_message
        ? '<div class="warn-box mt-8">Расчёт не завершён. Нажмите «Повторить расчёт».</div>'
        : "") +
      '<div class="flex mt-16"><button class="btn btn-outline btn-sm" id="pj-refresh" type="button">Обновить статус</button>' +
      '<button class="btn btn-outline btn-sm" id="pj-collapse" type="button">Свернуть</button>' +
      (job.status === "error" || isStuck
        ? '<button class="btn btn-navy btn-sm" id="pj-retry" type="button">Повторить расчёт</button>' +
          '<button class="btn btn-outline btn-sm" id="pj-reset" type="button">Сбросить статус</button>'
        : "") +
      (isRunning
        ? '<button class="btn btn-danger btn-sm" id="pj-cancel" type="button">Отменить расчёт</button>'
        : "") +
      (docsReady
        ? '<button class="btn btn-navy btn-sm" id="pj-docs" type="button">Документы расчёта (.xlsx / .docx)</button>'
        : "") + "</div></div>";
    $("#pj-refresh").addEventListener("click", refreshCalcJob);
    if ($("#pj-collapse")) {
      $("#pj-collapse").addEventListener("click", collapseCalcJob);
    }
    if (job.status === "error" || isStuck) {
      $("#pj-retry").addEventListener("click", function () { retryProjectCalc(job.id); });
      var resetBtn = $("#pj-reset");
      if (resetBtn) resetBtn.addEventListener("click", function () { resetProjectCalc(job.id); });
    }
    if (isRunning && $("#pj-cancel")) {
      $("#pj-cancel").addEventListener("click", function () { cancelProjectCalc(job.id); });
    }
    if (docsReady && $("#pj-docs")) {
      $("#pj-docs").addEventListener("click", function () { openCalcJobDocs(job.id); });
    }
  }

  var _calcResetInFlight = {};

  /// V193.2: тихий сброс устаревшей ошибочной задачи (реестр томов пуст).
  async function autoResetCalcJob(jobId) {
    if (!jobId || _calcResetInFlight[jobId]) return;
    _calcResetInFlight[jobId] = true;
    try {
      await sb.from("project_calc_jobs").update({
        status: "cancelled",
        error_message: null,
        progress_json: { line: "статус сброшен: реестр томов пуст", done: 0, total: 0 },
      }).eq("id", jobId);
    } catch (e) {
      console.warn("[calc reset]", e);
    } finally {
      setTimeout(function () { delete _calcResetInFlight[jobId]; }, 5000);
    }
  }

  /// V193.2: «Сбросить статус» — ошибка/зависание убираются сразу.
  async function resetProjectCalc(jobId) {
    if (!jobId) return;
    var upd = await sb.from("project_calc_jobs").update({
      status: "cancelled",
      error_message: null,
      progress_json: { line: "статус сброшен пользователем", done: 0, total: 0 },
    }).eq("id", jobId);
    if (upd.error) { toast("Не удалось сбросить: " + upd.error.message, 7000); return; }
    state.calcJob = null;
    state.calcJobId = null;
    toast("Статус сброшен — можно загружать тома заново");
    renderProjectProgress();
    renderProjectTabs();
  }

  /// V192.9: повторная постановка расчёта в очередь (после ошибки/таймаута).
  async function retryProjectCalc(jobId) {
    if (!jobId) return;
    var upd = await sb.from("project_calc_jobs").update({
      status: "queued",
      error_message: null,
      progress_json: { line: "заявка создана", done: 0, total: 0 },
    }).eq("id", jobId);
    if (upd.error) { toast("Не удалось перезапустить: " + upd.error.message, 7000); return; }
    state.calcJob = Object.assign({}, state.calcJob, {
      status: "queued", error_message: null,
      progress_json: { line: "заявка создана", done: 0, total: 0 },
    });
    wakeProjectWorker();
    toast("Расчёт поставлен в очередь повторно");
    renderProjectProgress();
    renderProjectTabs();
  }

  async function refreshCalcJob() {
    if (!state.calcJobId) return;
    var res = await sb.from("project_calc_jobs").select("*").eq("id", state.calcJobId).maybeSingle();
    if (res.data) {
      state.calcJob = res.data;
      renderProjectProgress();
      renderProjectTabs();
    }
  }

  async function openCalcDoc(path) {
    if (!path) { toast("Документ ещё не сформирован"); return; }
    var signed = await sb.storage.from("project_docs").createSignedUrl(path, 3600);
    if (signed.error) { toast("Не удалось получить ссылку: " + signed.error.message); return; }
    window.open(signed.data.signedUrl, "_blank");
  }

  function renderProjectTabs() {
    var box = $("#pj-tabs");
    if (!box) return;
    var job = state.calcJob;
    // V194.5.4 (ТЗ §3.2): вкладки ведомости свёрнуты до «Открыть расчёт».
    if (!job || !state.calcOpen) { box.innerHTML = ""; return; }
    var volumes = job.volumes_json || {};
    var cost = job.cost_model_json || {};
    var atoms = (volumes.atoms || []).concat(volumes.derived || [],
      volumes.machinery || [], volumes.services || []);
    var costRows = cost.rows || [];
    var totals = cost.totals || {};
    var area = num(job.total_area_m2) || num(cost.area_m2);
    var commercial = computeCommercial(cost, state.calcParams, area);
    // V193.9: три полноценные вкладки (единый стандарт с приложением).
    if (!state.calcTab) state.calcTab = "volumes";
    var tabs = [
      ["volumes", "Ведомость объёмов"],
      ["cost", "Себестоимость"],
      ["materials", "Свод материалов"],
      ["kp", "Калькулятор КП"],
    ];
    var tabsHtml = '<div class="calc-params-row mt-8" style="display:flex;gap:8px;flex-wrap:wrap;">' +
      tabs.map(function (item) {
        var active = state.calcTab === item[0];
        return '<button class="btn btn-sm ' + (active ? "btn-navy" : "btn-outline") +
          '" data-calc-tab="' + item[0] + '" type="button">' + item[1] + "</button>";
      }).join("") + "</div>";

    // V194.3 (ТЗ §1.4): ведомость группируется по конструктивам (раздел → позиции),
    // чтобы не было плоской простыни из 109 строк; в приложении это сворачиваемые карточки.
    var volumesHtml = '<div class="card mt-8"><h3>Ведомость объёмов (' + atoms.length + ')</h3>' +
      '<p class="small muted">Позиции спецификаций, у каждой указан лист PDF. Строки с меткой «ИИ-ПТО» синтезированы по нормам.</p>' +
      '<div class="table-wrap mt-8" style="max-height:52vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Раздел</th><th>Конструктив</th><th>Вид</th><th>Ед.</th><th class=\"num\">Кол-во</th><th>Лист / источник</th>" +
      "</tr></thead><tbody>" +
      (atoms.length ? volumesGroupedHtml(atoms.slice(0, 400)) :
        '<tr><td colspan="6" class="muted">Объёмы появятся после разбора томов.</td></tr>') +
      "</tbody></table></div></div>";

    var costHtml = '<div class="card mt-8"><h3>Себестоимость (Материалы / Работы / Техника)</h3>' +
      '<div class="grid grid-4 mt-8">' +
      kpi("Материалы", money(totals.materials), "без НДС") +
      kpi("Работы", money(totals.works), "без НДС") +
      kpi("Техника", money(totals.machinery), "маш-смены") +
      kpi("Общеплощадочные", money(totals.services), "геодезия, лаборатория, СИЗ") +
      "</div>" +
      '<div class="table-wrap mt-8" style="max-height:50vh;overflow:auto;"><table class="data"><thead><tr>' +
      '<th>Этап / позиция</th><th>Ед.</th><th class="num">Кол-во</th><th class="num">Цена</th>' +
      '<th class="num">Сумма</th><th>Источник цены</th></tr></thead><tbody>' +
      (costRows.length ? costRows.slice(0, 400).map(costRowHtml).join("") :
        '<tr><td colspan="6" class="muted">Себестоимость появится после этапа ценообразования.</td></tr>') +
      "</tbody></table></div>" +
      ((cost.unpriced && cost.unpriced.length)
        ? '<div class="warn-box mt-8">Без подтверждённой цены: ' + cost.unpriced.length +
          " позиций. Добавьте их в Базе расценок компании — расчёт подхватит цены при пересчёте.</div>"
        : "") +
      "</div>";

    // V194.3 (ТЗ §1.4): «Свод материалов» — одинаковые материалы одной строкой,
    // арматура раскрыта по классам; тот же блок, что на листе Excel «Свод материалов».
    var summary = cost.materials_summary || {};
    var summaryItems = summary.items || [];
    var summaryRebar = summary.rebar || [];
    var materialsHtml = '<div class="card mt-8"><div class="flex-between">' +
      '<h3 style="margin:0;">Свод материалов</h3>' +
      '<span class="small muted">групп: ' + (summary.groups || summaryItems.length) +
      " · " + money(summary.total || 0) + "</span></div>" +
      '<div class="table-wrap mt-8" style="max-height:50vh;overflow:auto;"><table class="data"><thead><tr>' +
      '<th>Материал</th><th>Ед.</th><th class="num">Объём</th>' +
      '<th class="num">Сумма, ₽</th><th class="num">Доля</th></tr></thead><tbody>' +
      (summaryItems.length ? summaryItems.map(function (item) {
        return "<tr><td>" + esc(item.title || item.key || "") + "</td><td>" +
          esc(item.unit || "") + '</td><td class="num">' + num(item.qty) + "</td>" +
          '<td class="num">' + money(item.total) + "</td>" +
          '<td class="num">' + num(item.share_percent).toFixed(1) + "%</td></tr>";
      }).join("") : '<tr><td colspan="5" class="muted">Свод появится после «Рассчитать стоимость».</td></tr>') +
      "</tbody></table></div>" +
      (summaryRebar.length
        ? '<h4 class="mt-16">Арматура по классам</h4>' +
          '<div class="table-wrap mt-8"><table class="data"><thead><tr><th>Класс</th>' +
          '<th class="num">Тоннаж</th><th class="num">Сумма, ₽</th></tr></thead><tbody>' +
          summaryRebar.map(function (row) {
            return "<tr><td>" + esc(row.key || "") + '</td><td class="num">' +
              num(row.qty_t) + '</td><td class="num">' + money(row.total) + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : "") +
      "</div>";

    var kpHtml = '<div class="card mt-8"><h3>Калькулятор КП</h3>' +
      '<div class="grid grid-2 mt-8"><div>' +
      commercialField("materials_percent", "Расходные материалы, %", "%") +
      commercialField("tooling_percent", "Инструмент и логистика, %", "%") +
      commercialField("travel_rub", "Командировочные, ₽", "₽") +
      commercialField("travel_people", "Командировка: человек", "чел.") +
      commercialField("travel_days", "Командировка: дней", "дн.") +
      commercialField("travel_per_person_day", "Ставка за день, ₽", "₽/день") +
      commercialField("overhead_percent", "Накладные расходы, %", "%") +
      commercialField("profit_percent", "Плановая прибыль ГП, %", "%") +
      '<label class="field"><span>Налоговый режим</span><select id="cc-tax">' +
      Object.keys(TAX_MODES).map(function (key) {
        return '<option value="' + key + '"' +
          (state.calcParams.tax_mode === key ? " selected" : "") + ">" +
          esc(TAX_MODES[key].title) + "</option>";
      }).join("") + "</select></label>" +
      '<button class="btn btn-navy" id="cc-save" type="button">Сохранить КП и пересчитать документы</button>' +
      "</div><div>" +
      '<div class="kpi"><span class="kpi-label">Предложение заказчику</span>' +
      '<span class="kpi-value" id="cc-total">' + money(commercial.total) + "</span>" +
      '<span class="kpi-note" id="cc-per-m2">' + money(commercial.pricePerM2) +
      " за 1 м² · " + esc(commercial.taxTitle) + "</span></div>" +
      '<div class="table-wrap mt-8"><table class="data"><tbody id="cc-body">' +
      commercialRowsHtml(commercial) + "</tbody></table></div>" +
      "</div></div></div>";

    var activeHtml = state.calcTab === "cost" ? costHtml
      : state.calcTab === "materials" ? materialsHtml
        : state.calcTab === "kp" ? kpHtml : volumesHtml;
    box.innerHTML = tabsHtml + activeHtml;

    $all("[data-calc-tab]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.calcTab = btn.getAttribute("data-calc-tab");
        renderProjectTabs();
      });
    });

    $all("[data-cc]", box).forEach(function (input) {
      input.addEventListener("input", function () {
        state.calcParams[input.getAttribute("data-cc")] = num(input.value);
        updateCommercialPreview();
      });
    });
    var taxSelect = $("#cc-tax");
    if (taxSelect) {
      taxSelect.addEventListener("change", function () {
        state.calcParams.tax_mode = taxSelect.value;
        updateCommercialPreview();
      });
    }
    var saveBtn = $("#cc-save");
    if (saveBtn) saveBtn.addEventListener("click", saveCalcParams);
  }

  /// V194.3: строки ведомости с заголовками конструктивных разделов
  /// (Фундаментная плита, Фундаментные стены, Механизация…) — без плоской простыни.
  function volumesGroupedHtml(list) {
    var groups = {};
    var order = [];
    (list || []).forEach(function (atom) {
      var section = String(atom.section || "").trim() || "Прочее";
      if (!groups[section]) { groups[section] = []; order.push(section); }
      groups[section].push(atom);
    });
    return order.map(function (section) {
      var rows = groups[section];
      var header = '<tr><td colspan="6" style="background:#EEF2FF;font-weight:700;">' +
        esc(section) + " · " + rows.length + " поз.</td></tr>";
      return header + rows.map(atomRowHtml).join("");
    }).join("");
  }

  function atomRowHtml(atom) {
    var synthesized = String(atom.origin || "") === "pto_synthesis";
    var source = atom.sheet_ref || atom.source || "";
    return "<tr><td>" + esc(atom.section || "") + "</td><td>" + esc(atom.title || "") +
      (synthesized ? ' <span class="pill pill-info small">ИИ-ПТО</span>' : "") +
      "</td><td>" + esc(atom.kind || "") + "</td><td>" + esc(atom.unit || "") +
      '</td><td class="num">' + qty(atom.qty) + "</td><td class=\"small\">" +
      esc(source) + "</td></tr>";
  }

  function costRowHtml(row) {
    return "<tr><td>" + esc(row.title || "") + '<div class="small muted">' + esc(row.section || "") + "</div></td><td>" +
      esc(row.unit || "") + '</td><td class="num">' + qty(row.qty) + '</td><td class="num">' +
      money(row.unit_price) + '</td><td class="num">' + money(row.total) + "</td><td class=\"small\">" +
      esc(row.price_source || "") + "</td></tr>";
  }

  function commercialField(key, label, suffix) {
    return '<label class="field"><span>' + esc(label) + "</span>" +
      '<input type="number" step="0.01" data-cc="' + key + '" value="' + num(state.calcParams[key]) + '" />' +
      '<span class="small muted">' + esc(suffix) + "</span></label>";
  }

  function commercialRowsHtml(c) {
    // V193.2: при режиме с НДС 22 % строка «Налог по режиму» не выводится —
    // в сводке остаются только НДС и итоговая цена.
    var vatPercent = num(c.vatPercent);
    var showModeTax = !(vatPercent >= 22);
    var rows = [
      ["Себестоимость без НДС", c.costTotal],
      ["Расходные материалы", c.materialsMarkup],
      ["Инструмент и логистика", c.tooling],
      ["Командировочные", c.travel],
      ["Накладные расходы", c.overhead],
      ["Полная себестоимость", c.prime],
      ["Плановая прибыль ГП", c.profit],
      ["База без НДС", c.base],
      ["НДС", c.vat],
    ];
    if (showModeTax) rows.push(["Налог по режиму", c.revenueTax]);
    rows.push(["ИТОГО предложение", c.total]);
    rows.push(["Стоимость 1 м²", c.pricePerM2]);
    var boldLabels = ["Полная себестоимость", "База без НДС", "ИТОГО предложение", "Стоимость 1 м²"];
    return rows.map(function (pair) {
      var bold = boldLabels.indexOf(pair[0]) >= 0;
      return "<tr" + (bold ? ' class="row-stage"' : "") + "><td>" + esc(pair[0]) +
        '</td><td class="num">' + money(pair[1]) + "</td></tr>";
    }).join("");
  }

  function updateCommercialPreview() {
    var job = state.calcJob;
    if (!job) return;
    var cost = job.cost_model_json || {};
    var area = num(job.total_area_m2) || num(cost.area_m2);
    var commercial = computeCommercial(cost, state.calcParams, area);
    var totalNode = $("#cc-total");
    if (totalNode) totalNode.textContent = money(commercial.total);
    var perNode = $("#cc-per-m2");
    if (perNode) perNode.textContent = money(commercial.pricePerM2) + " за 1 м² · " + commercial.taxTitle;
    var body = $("#cc-body");
    if (body) body.innerHTML = commercialRowsHtml(commercial);
  }

  async function saveCalcParams() {
    var job = state.calcJob;
    if (!job) { toast("Сначала создайте расчёт объекта"); return; }
    // V194.5.4 (ТЗ §3.2): сохраняем все поля commercial_params и режим объёма
    // работ. По умолчанию — full_cycle; strict_spec только при явном выборе.
    var payload = Object.assign({}, calcParamsDefaults(), state.calcParams, {
      calc_scope: state.calcParams.calc_scope === "strict_spec"
        ? "strict_spec" : "full_cycle",
      calc_scope_explicit: state.calcParams.calc_scope === "strict_spec",
      recalc_only: true,
    });
    var upd = await sb.from("project_calc_jobs").update({ commercial_params: payload }).eq("id", job.id);
    if (upd.error) { toast("Не удалось сохранить КП: " + upd.error.message); return; }
    toast("Параметры КП сохранены: документы пересчитает воркер без ИИ");
    refreshCalcJob();
  }

// ═════════ V192.9: наглядный мониторинг и заявки поставщиков ═════════
  // V194.6.0 (ТЗ §5.1): детектор рассинхрона версий двух воркеров.
  function evaluateWorkerSync(main, project) {
    var mainOk = !!(main && (main.ok === true || main.status === "ok"));
    var projectOk = !!(project && (project.ok === true || project.status === "ok"));
    var mainRelease = String((main && main.release) || "").trim();
    var projectRelease = String((project && project.release) || "").trim();
    if (!mainOk || !projectOk) {
      return {
        state: "offline", mainOk: mainOk, projectOk: projectOk,
        mainRelease: mainRelease, projectRelease: projectRelease,
        badge: "Воркер недоступен",
        details: (mainOk ? "" : "Сметный не отвечает. ") +
          (projectOk ? "" : "Проектный не отвечает."),
      };
    }
    if (mainRelease !== projectRelease) {
      return {
        state: "warning", mainOk: true, projectOk: true,
        mainRelease: mainRelease, projectRelease: projectRelease,
        badge: "Рассинхрон версий",
        details: "Сметный: " + (mainRelease || "—") +
          " · Проектный: " + (projectRelease || "—"),
      };
    }
    return {
      state: "ok", mainOk: true, projectOk: true,
      mainRelease: mainRelease, projectRelease: projectRelease,
      badge: "Работает · " + (mainRelease || "—"),
      details: "Сметный: " + (mainRelease || "—") +
        " · Проектный: " + (projectRelease || "—"),
    };
  }

  function adminStatusCard(title, state, details) {
    var ok = state === "ok";
    var warn = state === "warn";
    var color = ok ? "#10B981" : (warn ? "#F59E0B" : "#EF4444");
    var label = ok ? "Онлайн" : (warn ? "Внимание" : "Офлайн");
    return '<div class="card" style="padding:12px;">' +
      '<div class="flex-between"><strong style="font-size:13px;">' + esc(title) + "</strong>" +
      '<span class="pill" style="background:' + color + '22;color:' + color +
      ';border:1px solid ' + color + '55;">' + label + "</span></div>" +
      '<div class="small muted mt-8">' + details + "</div></div>";
  }

  async function loadAdminStatus() {
    var cards = $("#admin-cards");
    var raw = $("#admin-status");
    if (cards) cards.innerHTML = '<div class="muted">Проверяем сервисы…</div>';
    var bust = "?ts=" + Date.now() + "&force=1";
    var health = null;
    var providers = null;
    try {
      health = CFG.engineHealthUrl
        ? await (await fetch(CFG.engineHealthUrl + bust, { cache: "no-store" })).json()
        : { error: "engine_health_url_not_set" };
    } catch (e) {
      health = { error: "health_unreachable: " + String((e && e.message) || e) };
    }
    try {
      providers = CFG.engineProvidersUrl
        ? await (await fetch(CFG.engineProvidersUrl + bust, { cache: "no-store" })).json()
        : { error: "engine_providers_url_not_set" };
    } catch (e) {
      providers = { error: "providers_unreachable: " + String((e && e.message) || e) };
    }
    var dbOk = true;
    var dbError = "";
    try {
      var ping = await sb.from("organizations").select("id").limit(1);
      dbOk = !ping.error;
      dbError = ping.error ? ping.error.message : "";
    } catch (e) {
      dbOk = false;
      dbError = String((e && e.message) || e);
    }
    state.adminHealth = health;
    state.adminProviders = providers;
    // V194.1 (ТЗ §4): второй воркер (расчёт ПД/РД) — отдельный сервис Render.
    var projectHealth = null;
    try {
      projectHealth = CFG.projectWorkerHealthUrl
        ? await (await fetch(CFG.projectWorkerHealthUrl + bust, { cache: "no-store" })).json()
        : { error: "project_worker_health_url_not_set" };
    } catch (e) {
      projectHealth = { error: "project_worker_unreachable: " + String((e && e.message) || e) };
    }
    state.adminProjectHealth = projectHealth;
    if (cards) {
      var workerOk = !!(health && health.ok === true);
      var sync = evaluateWorkerSync(health, projectHealth);
      var workerState = sync.state === "warning" ? "warn" : (workerOk ? "ok" : "bad");
      var workerDetails = (workerOk
        ? "релиз " + esc(health.release || "—") + " · аптайм " +
          Math.round(num(health.uptime_s) / 60) + " мин"
        : esc((health && (health.error || health.status)) || "нет ответа")) +
        '<div class="mt-8" style="color:' + (sync.state === "warning" ? "#B45309" :
          (sync.state === "ok" ? "#047857" : "#B91C1C")) + ';">' +
        esc(sync.badge) + " · " + esc(sync.details) + "</div>";
      var routerai = (providers && providers.routerai) || {};
      var artemox = (providers && providers.artemox) || {};
      var deepseek = (providers && providers.deepseek) || {};
      // V194.7.1: баланс RouterAI больше не «пропадает молча»: если ключ не задан
      // на сервере или запрос к /credits не удался, карточка показывает причину
      // (без ключа и без секретов — только статус и URL эндпоинта).
      var routeraiReason = String(routerai.error_reason || routerai.error || "").trim();
      var routeraiBalance = routerai.balance == null
        ? (routerai.configured ? "баланс недоступен" : "ключ не задан на сервере")
        : "баланс " + esc(routerai.balance) + " " + esc(routerai.currency || "RUB");
      var routeraiDetails = esc(routerai.label || "RouterAI (routerai.ru)") + " · " +
        routeraiBalance +
        (routeraiReason ? '<div class="mt-8">' + esc(routeraiReason) + "</div>" : "") +
        '<div class="mt-8">ключ: ' + (routerai.configured ? "задан" : "нет") +
        " · эндпоинт: " + esc(routerai.endpoint || "/credits") + "</div>";
      // V194.1 (ТЗ §4): воркер ПД/РД отдаёт status: ok (без поля ok).
      var projectOk = !!(projectHealth &&
        (projectHealth.status === "ok" || projectHealth.ok === true));
      var projectDetails = projectOk
        ? "релиз " + esc(projectHealth.release || "—") + " · аптайм " +
          Math.round(num(projectHealth.uptime_s) / 60) + " мин" +
          '<div class="mt-8">разбор: ' + esc(projectHealth.parse_provider || "—") +
          " · " + esc(projectHealth.parse_model || "—") + "</div>" +
          '<div>второе мнение: ' + esc(projectHealth.second_opinion_provider || "—") +
          " · " + esc(projectHealth.second_opinion_model || "—") + "</div>"
        : esc(projectHealth && (projectHealth.error || projectHealth.status) || "нет ответа");
      var deepseekOk = !!(deepseek.configured && deepseek.status === "ok");
      var deepseekDetails = "модель deepseek-chat · роль «Основной разбор смет и ПД/РД»" +
        '<div class="mt-8">ключ: ' + (deepseekOk ? "активен" : "не активен") +
        " · провайдер: " + esc(deepseek.search_provider || "deepseek_direct") + "</div>" +
        '<div>баланс: ' + (deepseek.balance == null ? "—" :
          esc(deepseek.balance) + " " + esc(deepseek.currency || "")) + "</div>";
      cards.innerHTML = '<div class="grid grid-4">' +
        adminStatusCard("Python-воркер", workerState, workerDetails) +
        adminStatusCard("Воркер ПД/РД", projectOk ? "ok" : "bad", projectDetails) +
        adminStatusCard("RouterAI · gemini-3.8-flash",
          routerai.configured && routerai.status === "ok" ? "ok" : (routerai.configured ? "warn" : "bad"),
          routeraiDetails) +
        adminStatusCard("DeepSeek Direct", deepseekOk ? "ok" : (deepseek.configured ? "warn" : "bad"),
          deepseekDetails) +
        adminStatusCard("Artemox · hydrogen",
          artemox.configured && artemox.status ? "ok" : (artemox.configured ? "warn" : "bad"),
          esc(artemox.label || "Artemox") + " · " + esc(artemox.status || "—")) +
        adminStatusCard("База данных платформы", dbOk ? "ok" : "bad",
          dbOk ? "REST отвечает" : esc(dbError || "ошибка подключения")) +
        "</div>";
    }
    if (raw) {
      raw.textContent = JSON.stringify(
        { health: health, providers: providers, project_worker: projectHealth }, null, 2);
    }
  }

  function partnerApplicationsHtml(apps) {
    if (!apps || !apps.length) {
      return '<tr><td colspan="7" class="muted">Заявок пока нет.</td></tr>';
    }
    return apps.map(function (app) {
      var fileLink = app.price_file_url
        ? '<a class="btn btn-outline btn-sm" href="' + esc(app.price_file_url) +
          '" target="_blank" rel="noopener">Прайс</a>'
        : '<span class="muted small">нет файла</span>';
      var actions = app.status === "new"
        ? '<button class="btn btn-outline btn-sm" data-partner-approve="' + esc(app.id) +
          '" type="button">Одобрить</button>' +
          '<button class="btn btn-danger btn-sm" data-partner-reject="' + esc(app.id) +
          '" type="button">Отклонить</button>'
        : '<span class="muted small">' + esc(app.status) + "</span>";
      return "<tr><td><strong>" + esc(app.org_name) + "</strong>" +
        '<div class="small muted">ИНН ' + esc(app.inn || "—") + "</div></td>" +
        "<td>" + esc(app.city) + "</td>" +
        "<td>" + esc(app.contact_name) + '<div class="small muted">' + esc(app.phone) +
        (app.email ? " · " + esc(app.email) : "") + "</div></td>" +
        "<td>" + fileLink + "</td>" +
        '<td class="small">' + esc(app.comment || "") + "</td>" +
        "<td>" + pill(app.status, app.status === "new" ? "info" : (app.status === "approved" ? "ok" : "warn")) + "</td>" +
        '<td><div class="flex">' + actions + "</div></td></tr>";
    }).join("");
  }

  async function moderatePartnerApplication(appId, status) {
    var upd = await sb.from("partner_applications").update({ status: status }).eq("id", appId);
    if (upd.error) { toast("Решение не сохранено: " + upd.error.message, 7000); return; }
    if (status === "approved") {
      try {
        var app = await sb.from("partner_applications").select("inn").eq("id", appId).maybeSingle();
        var inn = app && app.data ? String(app.data.inn || "").replace(/\D+/g, "") : "";
        if (inn) {
          var org = await sb.from("organizations").select("id").eq("inn", inn).maybeSingle();
          if (org && org.data) {
            await sb.from("organizations").update({ is_price_partner: true }).eq("id", org.data.id);
          }
        }
      } catch (e) { /* привязка партнёра не критична */ }
    }
    toast(status === "approved" ? "Заявка одобрена" : "Заявка отклонена");
    renderRoute();
  }

  // ═════════ V193.3: посещаемость сайта (анонимно, 152-ФЗ) ═════════
  function visitsSummary(rows) {
    var now = Date.now();
    var day = 24 * 3600 * 1000;
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    function windowStats(sinceMs) {
      var users = {};
      var visits = 0;
      (rows || []).forEach(function (row) {
        var ts = Date.parse(String(row.created_at || ""));
        if (!Number.isFinite(ts) || ts < sinceMs) return;
        visits++;
        if (row.visitor_id) users[String(row.visitor_id)] = true;
      });
      return { users: Object.keys(users).length, visits: visits };
    }
    return {
      today: windowStats(todayStart.getTime()),
      week: windowStats(now - 7 * day),
      month: windowStats(now - 30 * day),
      sources: (rows || []).slice(0, 20).map(function (row) {
        return String(row.referrer || "").trim() || "прямой заход";
      }),
    };
  }

  function visitsCardHtml(rows) {
    var stats = visitsSummary(rows);
    function cell(label, data) {
      return '<div class="visits-cell"><div class="v-label">' + esc(label) + "</div>" +
        '<div class="v-value">' + data.users + ' <span class="v-note">уник.</span></div>' +
        '<div class="v-note">' + data.visits + ' визитов</div></div>';
    }
    var sources = {};
    (stats.sources || []).forEach(function (src) {
      var key = src.length > 70 ? src.slice(0, 70) + "…" : src;
      sources[key] = (sources[key] || 0) + 1;
    });
    var srcHtml = Object.keys(sources).map(function (key) {
      return '<span class="src">' + esc(key) + " · " + sources[key] + "</span>";
    }).join("") || '<span class="src">пока нет данных</span>';
    return '<div class="flex-between"><h3 style="margin:0;">Посещаемость сайта (neyroplan.ru)</h3>' +
      '<button class="btn btn-outline btn-sm" id="admin-visits-refresh" type="button">Обновить</button></div>' +
      '<p class="small muted">Анонимно: только случайный visitor_id в браузере. Без ФИО, e-mail и телефонов — 152-ФЗ.</p>' +
      '<div class="visits-grid">' +
      cell("Сегодня", stats.today) + cell("За 7 дней", stats.week) + cell("За 30 дней", stats.month) +
      "</div>" +
      '<div class="visits-sources"><strong>Последние источники перехода:</strong><br>' + srcHtml + "</div>";
  }

  // V194.6.0 (ТЗ §5.2): входящие заявки billing_requests.
  var BILLING_TYPE_TITLES = {
    upgrade: "Смена тарифа",
    renew: "Продление подписки",
    ai_reset: "Обновление лимита ИИ",
    storage_addon: "Дополнительное хранилище",
    custom_dev: "Индивидуальная доработка / интеграции",
  };

  function billingRequestsCardHtml(rows) {
    var list = rows || [];
    var body = list.length
      ? list.map(function (row) {
        var status = String(row.status || "new");
        var kind = status === "done" ? "ok" : (status === "rejected" ? "bad" : "warn");
        return "<tr><td>" + esc(row.org_name || ("Организация " + (row.org_id || "—"))) +
          '<div class="small muted">' + esc(row.contact_email || "") + "</div></td>" +
          "<td>" + esc(BILLING_TYPE_TITLES[row.request_type] || row.request_type) + "</td>" +
          "<td>" + esc(row.target_plan_code || "—") +
          '<div class="small muted">' + esc(row.billing_period || "monthly") +
          ((num(row.extra_gb) > 0) ? " · +" + num(row.extra_gb) + " ГБ" : "") + "</div></td>" +
          '<td class="num">' + money(row.amount_rub) + "</td>" +
          '<td class="small">' + esc(row.comment || "") + "</td>" +
          "<td>" + pill(status, kind) + "</td>" +
          '<td><div class="flex">' +
          '<button class="btn btn-outline btn-sm" data-billing-status="done" data-billing-id="' +
          esc(row.id) + '" type="button">Обработана</button>' +
          '<button class="btn btn-outline btn-sm" data-billing-status="rejected" data-billing-id="' +
          esc(row.id) + '" type="button">Отклонена</button>' +
          "</div></td></tr>";
      }).join("")
      : '<tr><td colspan="7" class="muted">Заявок пока нет.</td></tr>';
    return '<div class="card mt-16"><h3>Заявки на тарифы, лимиты ИИ и счета</h3>' +
      '<p class="small muted">Смена статуса «Новая» → «Обработана» после оплаты и продления тарифа.</p>' +
      '<div class="table-wrap mt-8" style="max-height:46vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Организация</th><th>Тип заявки</th><th>Тариф / период</th><th class=\"num\">Сумма</th>" +
      "<th>Комментарий</th><th>Статус</th><th>Действия</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>";
  }

  async function setBillingRequestStatus(id, status) {
    var res = await sb.from("billing_requests").update({ status: status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (res.error) { toast("Статус не изменён: " + res.error.message, 7000); return; }
    toast("Заявка: " + status);
    renderRoute();
  }

  async function renderAdminDashboard(root) {
    // V194.5 (ТЗ §5.1): полноэкранная плашка «Загрузка данных платформы…»
    // показывается ТОЛЬКО при первой отрисовке. Фоновое автообновление идёт
    // тихо, поверх уже загруженных таблиц (без моргания экрана).
    var dashboardNode = root.querySelector("[data-admin-dashboard]");
    var firstPaint = !dashboardNode;
    var keepScroll = window.scrollY || 0;
    if (firstPaint) {
      root.innerHTML = '<div class="muted">Загрузка данных платформы…</div>';
    }
    var orgs = await sb.from("organizations")
      .select("id, name, created_at, inn, kpp, ogrn, tariff_plan, plan_code, " +
        "plan_expires_at, billing_period, is_unlimited_override, extra_storage_gb, " +
        "admin_tariff_note, estimates_limit_month, access_until, is_blocked, is_price_partner")
      .order("id", { ascending: true }).limit(200);
    // V192.9: profiles читаем целиком (без списка полей) — отсутствующая колонка
    // раньше роняла весь запрос, и счётчик «Люди» показывал 0.
    var profiles = await sb.from("profiles").select("*").limit(1000);
    var jobs = await sb.from("estimate_jobs").select("id, status, organization_id, created_at")
      .order("created_at", { ascending: false }).limit(200);
    var marketplaceRes = await sb.from("marketplace_posts")
      .select("id, title, post_type, city, specialization, status, created_at")
      .order("created_at", { ascending: false }).limit(100);
    var appsRes = await sb.from("partner_applications")
      .select("*").order("created_at", { ascending: false }).limit(100);
    // V193.3: анонимная статистика посещаемости (SELECT разрешён только суперадмину).
    var visitsRes = await sb.from("site_visits")
      .select("visitor_id, page_path, referrer, created_at")
      .order("created_at", { ascending: false }).limit(2000);
    // V194.6.0 (ТЗ §5.2): входящие заявки на оплату/счёт и докупки.
    var billingRes = await sb.from("billing_requests")
      .select("id, org_id, request_type, target_plan_code, billing_period, extra_gb, " +
        "amount_rub, comment, status, created_at, org_name, contact_email")
      .order("created_at", { ascending: false }).limit(100);

    var orgList = orgs.data || [];
    var profileList = profiles.data || [];
    var jobList = jobs.data || [];
    var marketplacePosts = marketplaceRes.data || [];
    var partnerApps = appsRes.data || [];
    var visitList = visitsRes.data || [];
    var billingRequests = billingRes.data || [];
    var profilesError = profiles.error ? profiles.error.message : "";

    var peopleByOrg = {};
    profileList.forEach(function (p) {
      var key = String(p.organization_id == null ? "" : p.organization_id);
      if (!key) return;
      peopleByOrg[key] = (peopleByOrg[key] || 0) + 1;
    });

    var orgRows = orgList.map(function (org) {
      var users = peopleByOrg[String(org.id)] || 0;
      var orgJobs = jobList.filter(function (j) { return String(j.organization_id) === String(org.id); });
      var done = orgJobs.filter(function (j) { return j.status === "done"; }).length;
      return "<tr><td>" + esc(org.id) + '</td><td><strong>' + esc(org.name || "Организация") +
        '</strong><div class="small muted">ИНН ' + esc(org.inn || "—") + " · КПП " + esc(org.kpp || "—") +
        (org.is_price_partner ? " · " + pill("партнёр Книги цен", "ok") : "") + "</div></td>" +
        "<td>" + esc(tariffTitle(org.plan_code || org.tariff_plan)) + "</td>" +
        "<td>" + orgTariffBadge(org) + "</td>" +
        '<td class="num">' + users + "</td>" +
        '<td class="num">' + orgJobs.length + "</td>" +
        '<td class="num">' + done + "</td>" +
        "<td>" + orgStatusPill(org) + "</td>" +
        '<td><div class="flex">' +
        '<button class="btn btn-outline btn-sm" data-org-tariff="' + esc(org.id) + '" type="button">Тариф и доступы</button>' +
        '<button class="btn btn-outline btn-sm" data-org-block="' + esc(org.id) + '" type="button">' +
        (org.is_blocked ? "Разблок" : "Блок") + "</button>" +
        '<button class="btn btn-outline btn-sm" data-org-partner="' + esc(org.id) + '" type="button">' +
        (org.is_price_partner ? "Снять партнёра" : "Партнёр Книги цен") + "</button>" +
        '<button class="btn btn-danger btn-sm" data-org-del="' + esc(org.id) + '" type="button">Удалить</button>' +
        "</div></td></tr>";
    }).join("");


    root.innerHTML =
      '<div data-admin-dashboard="1">' +
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Платформа · панель владельца</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Доступ подтверждён: is_superadmin + повторный QR-код/пароль (30 минут).</p></div>' +
      pill("Доступ подтверждён · 30 мин", "ok") + "</div>" +
      '<div class="grid grid-4 mt-16">' +
      kpi("Организаций", String(orgList.length), "все компании платформы") +
      kpi("Пользователей", String(profileList.length), profilesError ? "ОШИБКА ЧТЕНИЯ" : "profiles") +
      kpi("Смет в системе", String(jobList.length), "последние 200") +
      kpi("Заявок поставщиков", String(partnerApps.filter(function (a) { return a.status === "new"; }).length),
        "новых в Книгу цен") +
      "</div>" +
      (profilesError
        ? '<div class="warn-box mt-16">Не удалось прочитать profiles: ' + esc(profilesError) +
          ". Счётчик «Люди» и список пользователей могут быть неполными.</div>"
        : "") +
      '<div class="card mt-16"><div class="flex-between"><h3 style="margin:0;">Мониторинг воркеров и провайдеров</h3>' +
      '<button class="btn btn-outline btn-sm" id="admin-status-refresh" type="button">Обновить</button></div>' +
      '<div class="mt-8" id="admin-cards"><div class="muted">Проверяем сервисы…</div></div>' +
      '<details class="mt-8"><summary class="small muted" style="cursor:pointer;">Технические детали (JSON)</summary>' +
      '<pre class="small mono" id="admin-status" style="white-space:pre-wrap;max-height:240px;overflow:auto;' +
      'background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px;">загрузка…</pre></details></div>' +
      '<div class="card mt-16" id="admin-visits"></div>' +
      '<div class="card mt-16"><h3>Заявки поставщиков в Книгу цен</h3>' +
      '<div class="table-wrap mt-8" style="max-height:44vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Компания</th><th>Город</th><th>Контакт</th><th>Прайс</th><th>Комментарий</th><th>Статус</th><th>Действия</th>" +
      "</tr></thead><tbody>" + partnerApplicationsHtml(partnerApps) + "</tbody></table></div></div>" +
      '<div class="card mt-16"><h3>Организации, тарифы и доступы</h3>' +
      '<div class="table-wrap mt-8" style="max-height:52vh;overflow:auto;"><table class="data"><thead><tr>' +
      '<th>ID</th><th>Организация</th><th>Тариф</th><th>Срок</th>' +
      '<th class="num">Люди</th><th class="num">Сметы</th><th class="num">Готово</th><th>Статус</th><th>Действия</th>' +
      "</tr></thead><tbody>" +
      (orgRows || '<tr><td colspan="9" class="muted">Организаций пока нет.</td></tr>') +
      "</tbody></table></div></div>" +
      billingRequestsCardHtml(billingRequests) +
      '<div class="card mt-16"><h3>Пользователи платформы</h3>' +
      '<div class="table-wrap mt-8" style="max-height:52vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>ФИО</th><th>E-mail</th><th>Тип аккаунта</th><th>Организация</th><th>Роль</th>" +
      "<th>Регистрация</th><th>Последний визит</th><th>Действия</th>" +
      "</tr></thead><tbody>" + adminUsersRows(profileList, orgList) + "</tbody></table></div>" +
      '<p class="small muted mt-8">Сброс веб-сессий завершает все браузерные входы пользователя (нужен повторный QR-вход).</p></div>' +
      '<div class="card mt-16"><h3>Модерация Биржи подрядов</h3>' +
      '<p class="small muted">Владелец платформы может опубликовать, скрыть или удалить объявление.</p>' +
      '<div class="table-wrap mt-8" style="max-height:46vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Заголовок</th><th>Тип</th><th>Город · работы</th><th>Статус</th><th>Создано</th><th>Действия</th>" +
      "</tr></thead><tbody>" + marketplaceModerationHtml(marketplacePosts) + "</tbody></table></div></div>" +
      "</div>";
    if (!firstPaint) {
      // Тихая замена DOM: возвращаем пользователя на ту же позицию прокрутки.
      window.scrollTo(0, keepScroll);
    }


    $("#admin-status-refresh").addEventListener("click", loadAdminStatus);
    loadAdminStatus();

    // V193.3: карточка посещаемости с обновлением без полной перерисовки админки.
    function paintVisits(rows) {
      var box = $("#admin-visits");
      if (!box) return;
      box.innerHTML = visitsCardHtml(rows);
      var refreshBtn = $("#admin-visits-refresh");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", async function () {
          refreshBtn.disabled = true;
          var res = await sb.from("site_visits")
            .select("visitor_id, page_path, referrer, created_at")
            .order("created_at", { ascending: false }).limit(2000);
          paintVisits(res.data || []);
        });
      }
    }
    paintVisits(visitList);

    function pickOrg(attr) {
      return orgList.filter(function (o) { return String(o.id) === attr; })[0] || null;
    }
    $all("[data-org-tariff]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openOrgTariffModal(pickOrg(btn.getAttribute("data-org-tariff")));
      });
    });
    $all("[data-org-block]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        toggleOrgBlock(pickOrg(btn.getAttribute("data-org-block")));
      });
    });
    $all("[data-org-partner]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        toggleOrgPartner(pickOrg(btn.getAttribute("data-org-partner")));
      });
    });
    $all("[data-org-del]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openDeleteOrgModal(pickOrg(btn.getAttribute("data-org-del")));
      });
    });
    $all("[data-user-sessions]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        resetUserWebSessions(btn.getAttribute("data-user-sessions"));
      });
    });
    $all("[data-post-status]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        moderateMarketplacePost(btn.getAttribute("data-post-status"), btn.getAttribute("data-status"));
      });
    });
    $all("[data-post-delete]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteMarketplacePost(btn.getAttribute("data-post-delete"));
      });
    });
    $all("[data-partner-approve]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        moderatePartnerApplication(btn.getAttribute("data-partner-approve"), "approved");
      });
    });
    $all("[data-partner-reject]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        moderatePartnerApplication(btn.getAttribute("data-partner-reject"), "rejected");
      });
    });
    $all("[data-billing-status]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        setBillingRequestStatus(btn.getAttribute("data-billing-id"),
          btn.getAttribute("data-billing-status"));
      });
    });
  }


  // ═════════ V194.5.6-C (ТЗ §4): «Связаться с разработчиком» / «Партнёрам» ═════════
  var SUPPORT_EMAIL = "neyroplan@mail.ru";
  var SUPPORT_TELEGRAM = "https://t.me/neyroplan";

  /// Единый эндпоинт отправки письма (SMTP Python-воркера).
  function supportEndpoint() {
    var direct = String(CFG.supportUrl || "").trim();
    if (direct) return direct;
    var base = String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
    return base ? base + "/api/support/contact" : "";
  }

  function copySupportEmail() {
    var text = SUPPORT_EMAIL;
    function done() { toast("Адрес " + text + " скопирован"); }
    function fallback() {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        done();
      } catch (e) {
        toast("Скопируйте адрес вручную: " + text, 7000);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  /// Единая модалка: почта neyroplan@mail.ru, Telegram-канал и короткая форма.
  function openFeedbackModal(topic) {
    var isPartner = String(topic || "") === "partnership";
    var defaultTopic = isPartner ? "partnership" : "support";
    var email = String(state.userEmail || "").trim();
    var orgName = String(state.orgName || "").trim();
    openModal(isPartner ? "Партнёрам · НейроПлан" : "Связаться с разработчиком",
      '<p class="small">' + (isPartner
        ? "Партнёрство, размещение прайса в Книге цен, интеграции и совместные проекты."
        : "Вопрос по расчётам, ошибка в приложении или идея развития платформы.") +
      " Пишите напрямую разработчику — мы отвечаем с <strong>" + esc(SUPPORT_EMAIL) + "</strong> " +
      "и в Telegram-канале.</p>" +
      '<div class="card" style="padding:12px;">' +
      '<div class="flex" style="gap:6px;flex-wrap:wrap;align-items:center;">' +
      '<strong>Почта:</strong><span>' + esc(SUPPORT_EMAIL) + "</span></div>" +
      '<div class="flex mt-8" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-outline btn-sm" id="fb-copy" type="button">Скопировать</button>' +
      '<a class="btn btn-outline btn-sm" href="mailto:' + esc(SUPPORT_EMAIL) +
      '?subject=' + encodeURIComponent(isPartner ? "Партнёрство" : "Вопрос / поддержка") +
      '">Написать письмо</a>' +
      '<a class="btn btn-navy btn-sm" href="' + esc(SUPPORT_TELEGRAM) +
      '" target="_blank" rel="noopener noreferrer">Telegram-канал НейроПлан</a>' +
      "</div>" +
      '<div class="small muted mt-8">Автоматически приложим: ' +
      esc(email || "ваш e-mail укажете ниже") + " · " + esc(orgName || "организация") +
      " · версия " + esc(String(CFG.release || "")) + "</div></div>" +
      '<div class="form-row mt-16">' +
      '<label class="field"><span>Ваше имя</span>' +
      '<input type="text" id="fb-name" autocomplete="name" placeholder="Иван" /></label>' +
      '<label class="field"><span>E-mail для ответа</span>' +
      '<input type="email" id="fb-email" autocomplete="email" value="' + esc(email) + '" /></label>' +
      '<label class="field"><span>Организация</span>' +
      '<input type="text" id="fb-org" value="' + esc(orgName) + '" /></label>' +
      '<label class="field"><span>Тема</span><select id="fb-topic">' +
      '<option value="support"' + (defaultTopic === "support" ? " selected" : "") +
      ">Вопрос / поддержка</option>" +
      '<option value="partnership"' + (defaultTopic === "partnership" ? " selected" : "") +
      ">Партнёрство</option>" +
      '<option value="bug">Ошибка в приложении</option>' +
      '<option value="idea">Идея развития</option>' +
      "</select></label></div>" +
      '<label class="field mt-8"><span>Сообщение</span>' +
      '<textarea id="fb-message" rows="4" placeholder="Опишите вопрос: объект, смета, шаги до ошибки…"></textarea></label>' +
      '<div class="small" id="fb-status" style="min-height:18px;color:#B91C1C;"></div>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="fb-send" type="button">' +
      "Отправить на " + esc(SUPPORT_EMAIL) + "</button>" +
      (isPartner
        ? '<button class="btn btn-outline" id="fb-price-book" type="button">' +
          "Заявка в Книгу цен</button>"
        : "") +
      "</div>");
    var copyBtn = $("#fb-copy");
    if (copyBtn) copyBtn.addEventListener("click", copySupportEmail);
    var sendBtn = $("#fb-send");
    if (sendBtn) sendBtn.addEventListener("click", function () { sendFeedbackMessage(isPartner); });
    var priceBtn = $("#fb-price-book");
    if (priceBtn) priceBtn.addEventListener("click", openPartnerApplyModal);
  }
  /// Короткое письмо на neyroplan@mail.ru через SMTP воркера + журнал обращений.
  async function sendFeedbackMessage(isPartner) {
    var status = $("#fb-status");
    var button = $("#fb-send");
    var message = String(($("#fb-message") || {}).value || "").trim();
    var email = String(($("#fb-email") || {}).value || "").trim();
    var topic = String(($("#fb-topic") || {}).value || (isPartner ? "partnership" : "support"));
    if (status) status.textContent = "";
    if (!email || email.indexOf("@") < 0) {
      if (status) status.textContent = "Укажите корректный e-mail для ответа";
      return;
    }
    if (message.length < 5) {
      if (status) status.textContent = "Опишите вопрос — минимум 5 символов";
      return;
    }
    var endpoint = supportEndpoint();
    if (!endpoint) {
      if (status) status.textContent = "Отправка недоступна: адрес воркера не настроен";
      return;
    }
    if (button) { button.disabled = true; button.textContent = "Отправляем…"; }
    try {
      var resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic,
          name: String(($("#fb-name") || {}).value || "").trim(),
          email: email,
          org_name: String(($("#fb-org") || {}).value || "").trim(),
          message: message,
          app_version: String(CFG.release || ""),
          platform: "web",
          page_url: String(location.href || "").slice(0, 500),
          user_id: state.userId || null,
          organization_id: state.orgId || null,
        }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data || data.ok !== true) {
        throw new Error((data && (data.error || data.message)) || ("HTTP " + resp.status));
      }
      closeModal();
      toast(data.delivered
        ? "Письмо отправлено на " + SUPPORT_EMAIL
        : "Обращение сохранено — ответим на " + email, 7000);
    } catch (e) {
      if (status) status.textContent = "Не отправлено: " + ((e && e.message) || e);
    } finally {
      if (button) { button.disabled = false; button.textContent = "Отправить на " + SUPPORT_EMAIL; }
    }
  }



  // ═════════ V192.9: витрина «Для партнёров» и заявка поставщика ═════════
  function openPartnerApplyModal() {
    openModal("Для партнёров · Книга цен НейроПлана",
      '<p class="small">Разместите прайс производителя или базы стройматериалов в платной ' +
      "<strong>Книге цен</strong>. Ваши позиции подставляются в расчёты смет и объектов по ПД/РД " +
      "с учётом логистики: цена, город склада и прямая ссылка на товар видны инженеру до веб-поиска.</p>" +
      '<div class="grid grid-3 mt-8">' +
      '<div class="card" style="padding:10px;"><strong>Приоритет в расчётах</strong>' +
      '<div class="small muted">Партнёрская цена проверяется раньше книги цен и интернета.</div></div>' +
      '<div class="card" style="padding:10px;"><strong>Транспортное плечо</strong>' +
      '<div class="small muted">Логистика считается до города объекта по дорожной сети.</div></div>' +
      '<div class="card" style="padding:10px;"><strong>Прямая ссылка</strong>' +
      '<div class="small muted">Инженер видит карточку товара и подтверждает цену.</div></div></div>' +
      '<div class="form-row mt-16">' +
      '<label class="field"><span>Название компании</span><input type="text" id="pa-org" placeholder="ООО «Бетон-Строй»" /></label>' +
      '<label class="field"><span>ИНН</span><input type="text" id="pa-inn" placeholder="10 или 12 цифр" /></label>' +
      '<label class="field"><span>Город склада</span><input type="text" id="pa-city" placeholder="Москва" /></label>' +
      "</div>" +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Контактное лицо</span><input type="text" id="pa-name" /></label>' +
      '<label class="field"><span>Телефон</span><input type="tel" id="pa-phone" placeholder="+7 900 000-00-00" /></label>' +
      '<label class="field"><span>E-mail</span><input type="email" id="pa-email" placeholder="sales@company.ru" /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Прайс (XLSX/CSV, до 10 МБ)</span>' +
      '<input type="file" id="pa-file" accept=".xlsx,.csv" /></label>' +
      '<label class="field mt-8"><span>Комментарий</span><input type="text" id="pa-comment" placeholder="Ассортимент, условия, регионы" /></label>' +
      '<div class="small muted mt-8" id="pa-status"></div>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="pa-send" type="button">Отправить заявку</button></div>');
    $("#pa-send").addEventListener("click", submitPartnerApplication);
  }

  async function submitPartnerApplication() {
    var payload = {
      org_name: String($("#pa-org").value || "").trim(),
      inn: String($("#pa-inn").value || "").replace(/\D+/g, "") || null,
      city: String($("#pa-city").value || "").trim(),
      contact_name: String($("#pa-name").value || "").trim(),
      phone: String($("#pa-phone").value || "").trim(),
      email: String($("#pa-email").value || "").trim() || null,
      comment: String($("#pa-comment").value || "").trim() || null,
      price_file_url: null,
      status: "new",
    };
    if (!payload.org_name || !payload.city || !payload.contact_name || !payload.phone) {
      toast("Заполните компанию, город, контакт и телефон");
      return;
    }
    var statusNode = $("#pa-status");
    var btn = $("#pa-send");
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    var fileInput = $("#pa-file");
    var file = fileInput && fileInput.files ? fileInput.files[0] : null;
    if (file) {
      if (statusNode) statusNode.textContent = "Загружаем прайс…";
      var safe = sanitizeStorageKey(file.name);
      var path = "applications/" + Date.now() + "_" + safe;
      var up = await sb.storage.from("partner_prices")
        .upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (up.error) {
        if (statusNode) statusNode.textContent = "Прайс не загружен: " + up.error.message;
      } else {
        var pub = sb.storage.from("partner_prices").getPublicUrl(path);
        payload.price_file_url = (pub && pub.data && pub.data.publicUrl) || null;
      }
    }
    var res = await sb.from("partner_applications").insert(payload);
    if (btn) { btn.disabled = false; btn.textContent = "Отправить заявку"; }
    if (res.error) {
      if (statusNode) statusNode.textContent = "Заявка не отправлена: " + res.error.message;
      return;
    }
    closeModal();
    toast("Заявка отправлена — менеджер Книги цен свяжется с вами", 6000);
  }

  // ─────────────────── Защищённый раздел суперадмина (/admin) ───────────────────
  // V192.6: вместо TOTP-2FA — подтверждение доступа на 30 минут двумя способами:
  //   1) повторный QR-код (purpose = 'admin_verify') с телефона суперадмина;
  //   2) резервный пароль учётной записи (если телефон недоступен).
  function readAdminVerifiedUntil() {
    try {
      var raw = sessionStorage.getItem(ADMIN_VERIFY_KEY);
      var ts = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(ts) && ts > Date.now() ? ts : 0;
    } catch (e) {
      return 0;
    }
  }

  function markAdminVerified() {
    var until = Date.now() + ADMIN_VERIFY_WINDOW_MS;
    state.adminVerifiedUntil = until;
    try { sessionStorage.setItem(ADMIN_VERIFY_KEY, String(until)); } catch (e) {}
    return until;
  }

  function clearAdminVerified() {
    state.adminVerifiedUntil = 0;
    try { sessionStorage.removeItem(ADMIN_VERIFY_KEY); } catch (e) {}
  }

  function isAdminVerified() {
    return readAdminVerifiedUntil() > Date.now();
  }

  async function renderAdmin(root) {
    root.innerHTML = '<div class="muted">Проверяем права владельца платформы…</div>';
    if (!(await requireAuth(root))) return;
    if (!state.isSuper) {
      root.innerHTML = '<div class="card"><h3>Доступ закрыт</h3>' +
        '<p>Раздел доступен только владельцу платформы. Права проверяются строго на сервере: ' +
        '<span class="mono">profiles.is_superadmin = true</span>.</p>' +
        '<p class="small muted mt-8">Мобильное приложение больше не содержит экранов суперадминки — всё управление здесь, в вебе.</p></div>';
      return;
    }
    if (!isAdminVerified()) {
      root.innerHTML = '<div class="card"><h3>Доступ суперадминистра не подтверждён</h3>' +
        '<p class="small muted">Админка откроется после подтверждения по QR-коду с телефона владельца ' +
        'или по паролю учётной записи. Окно подтверждения — 30 минут.</p>' +
        '<button class="btn btn-navy mt-16" id="admin-verify-start" type="button">Подтвердить доступ</button></div>';
      var startBtn = $("#admin-verify-start");
      if (startBtn) startBtn.addEventListener("click", openAdminVerifyModal);
      openAdminVerifyModal();
      return;
    }
    await renderAdminDashboard(root);
  }

  /// V192.6: модальное окно «Подтверждение доступа суперадминистратора».
  function closeAdminVerifyTimers() {
    if (state.adminVerify.timer) {
      clearInterval(state.adminVerify.timer);
      state.adminVerify.timer = null;
    }
  }

  function openAdminVerifyModal() {
    closeAdminVerifyTimers();
    openModal("Подтверждение доступа суперадминистратора",
      '<p class="small muted">Основной способ — отсканировать QR-код камерой телефона, ' +
      "на котором выполнен вход под владельцем платформы. Резервный способ — пароль учётной записи " +
      "(если телефон недоступен). Подтверждение действует 30 минут.</p>" +
      '<div class="card mt-8"><h3>1. Повторный QR-код</h3>' +
      '<div class="mt-8"><div class="qr-canvas" id="admin-qr"></div></div>' +
      '<div class="small muted mt-8" id="admin-qr-status">Готовим одноразовый код…</div>' +
      '<button class="btn btn-outline btn-sm mt-8" id="admin-qr-refresh" type="button">Обновить QR-код</button></div>' +
      '<div class="card mt-16"><h3>2. Резервный пароль</h3>' +
      '<label class="field mt-8"><span>Пароль учётной записи ' + esc(state.userEmail || "владельца") + "</span>" +
      '<input type="password" id="admin-password" autocomplete="current-password" /></label>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="admin-password-login" type="button">Войти по паролю</button>' +
      '<span class="small muted">Вход по e-mail и паролю · neyroplan@mail.ru</span></div></div>');
    var refreshBtn = $("#admin-qr-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", startAdminQr);
    var passBtn = $("#admin-password-login");
    if (passBtn) passBtn.addEventListener("click", adminPasswordVerify);
    startAdminQr();
  }

  /// Одноразовый челлендж purpose = 'admin_verify' (2 минуты, без выдачи сессии).
  async function startAdminQr() {
    closeAdminVerifyTimers();
    var statusNode = $("#admin-qr-status");
    var qrNode = $("#admin-qr");
    if (qrNode) qrNode.innerHTML = "";
    if (statusNode) statusNode.textContent = "Создаём одноразовый код…";
    var created = await invokeQr({
      action: "create",
      purpose: "admin_verify",
      device_label: String((window.navigator && window.navigator.userAgent) || "").slice(0, 90) || "Веб-браузер",
    });
    if (!created.ok || !created.token) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-bad">' +
          esc(created.error === "not_superadmin" ? "Аккаунт не является владельцем платформы" : (created.error || "Не удалось создать код")) +
          "</span>";
      }
      return;
    }
    state.adminVerify.token = String(created.token);
    state.adminVerify.expiresAt = Date.parse(String(created.expires_at || "")) || (Date.now() + 120000);
    if (!$("#admin-qr")) return; // окно уже закрыли — опрос не нужен
    try {
      if (qrNode && window.QRCode) {
        new window.QRCode(qrNode, {
          text: String(created.deep_link || created.token),
          width: 190,
          height: 190,
          correctLevel: window.QRCode.CorrectLevel.M,
        });
      } else if (qrNode) {
        qrNode.textContent = String(created.deep_link || created.token);
      }
    } catch (e) {
      if (qrNode) qrNode.textContent = String(created.deep_link || created.token);
    }
    renderAdminQrCountdown();
    state.adminVerify.timer = setInterval(async function () {
      if (Date.now() > state.adminVerify.expiresAt) {
        closeAdminVerifyTimers();
        var expiredNode = $("#admin-qr-status");
        if (expiredNode) expiredNode.innerHTML = '<span class="pill pill-warn">Код истёк — обновите QR-код</span>';
        return;
      }
      renderAdminQrCountdown();
      var status = await invokeQr({ action: "status", token: state.adminVerify.token });
      if (status && status.ok && (status.status === "approved" || status.admin_verified)) {
        closeAdminVerifyTimers();
        await completeAdminVerify("qr");
      } else if (status && status.ok && status.status === "expired") {
        closeAdminVerifyTimers();
        var staleNode = $("#admin-qr-status");
        if (staleNode) staleNode.innerHTML = '<span class="pill pill-warn">Код истёк — обновите QR-код</span>';
      }
    }, 2000);
  }

  function renderAdminQrCountdown() {
    var node = $("#admin-qr-status");
    if (!node) return;
    var left = Math.max(0, Math.round((state.adminVerify.expiresAt - Date.now()) / 1000));
    node.innerHTML = '<span class="pill pill-info">Отсканируйте код в приложении · осталось ' + left + " с</span>";
  }

  async function adminPasswordVerify() {
    var input = $("#admin-password");
    var password = input ? String(input.value || "") : "";
    if (!password) { toast("Введите пароль учётной записи"); return; }
    var btn = $("#admin-password-login");
    if (btn) { btn.disabled = true; btn.textContent = "Проверяем…"; }
    var res = await sb.auth.signInWithPassword({ email: state.userEmail, password: password });
    if (btn) { btn.disabled = false; btn.textContent = "Войти по паролю"; }
    if (res.error) {
      toast("Пароль не принят: " + res.error.message, 6000);
      return;
    }
    await loadProfile();
    renderSessionBadge();
    if (!state.isSuper) {
      toast("У аккаунта нет прав владельца платформы", 6000);
      return;
    }
    await completeAdminVerify("password");
  }

  async function completeAdminVerify(method) {
    markAdminVerified();
    closeAdminVerifyTimers();
    closeModal();
    toast("Доступ суперадминистра подтверждён на 30 минут (" +
      (method === "qr" ? "QR-код" : "пароль") + ")", 5000);
    if (location.hash !== "#/admin") location.hash = "#/admin";
    else renderRoute();
  }

  /// V192.7: живой статус воркера и провайдеров (кнопка «Обновить статус»).





  // ═══════════════ V192.4 (Этап 3.1): «Финансы» — АРМ бухгалтера ═══════════════
  var FIN_TYPES = ["приход", "расход", "аванс", "закрытие"];

  function financeFilters() {
    // V193.10: по умолчанию фильтры открыты и привязаны к активному объекту.
    return state.finFilters || (state.finFilters = {
      projectId: num(state.activeProjectId) || 0,
      from: "", to: "", type: "", counterparty: "", status: "",
    });
  }

  async function renderFinance(root) {
    root.innerHTML = '<div class="muted">Загрузка финансов…</div>';
    if (!(await requireAuth(root))) return;
    try {
      if (!(state.projects || []).length) await loadProjectsList();
      var res = await sb.from("finance_transactions").select("*")
        .eq("organization_id", state.orgId)
        .order("date", { ascending: false }).limit(1000);
      if (res.error) {
        root.innerHTML = '<div class="warn-box">Не удалось прочитать финансы: ' +
          esc(res.error.message) + "</div>";
        return;
      }
    state.finRows = res.data || [];
    var projects = await sb.from("projects").select("id, name").order("name").limit(200);
    var projectRows = projects.data || [];
    // V193.0: роль «Прораб»/«Сотрудник» видит финансы только по своим объектам.
    if (roleIsRestricted()) {
      var assigned = await assignedProjectIds();
      if (assigned.length) {
        projectRows = projectRows.filter(function (row) {
          return assigned.indexOf(num(row.id)) >= 0;
        });
      }
    }
    state.finProjects = projectRows;
    var f = financeFilters();
    var projectOptions = '<option value="0">Все объекты</option>' +
      state.finProjects.map(function (row) {
        return '<option value="' + esc(row.id) + '"' +
          (num(row.id) === num(f.projectId) ? " selected" : "") + ">" +
          esc(row.name || ("Объект " + row.id)) + "</option>";
      }).join("");
    var typeOptions = '<option value="">Все типы</option>' + FIN_TYPES.map(function (type) {
      return '<option value="' + esc(type) + '"' +
        (f.type === type ? " selected" : "") + ">" + esc(type) + "</option>";
    }).join("");
    // V194.2 (ТЗ §3.2): материалы рабочей сметы объекта для блока «Учёт по объекту».
    var wsProjectId = num(f.projectId) || num(state.activeProjectId) || 0;
    var wsMaterialsRes = wsProjectId
      ? await sb.from("work_statement_items").select("id, name, unit")
        .eq("organization_id", state.orgId).eq("project_id", wsProjectId)
        .eq("item_type", "material").order("sort_order").limit(500)
      : { data: [] };
    var materialsOptions = ((wsMaterialsRes && wsMaterialsRes.data) || []).map(function (row) {
      return '<option value="' + esc(row.id) + '">' + esc(row.name || "") +
        " (" + esc(row.unit || "") + ")</option>";
    }).join("");
    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Финансы</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">АРМ бухгалтера: операции по объектам, счета и оплаты.</p></div>' +
      '<button class="btn btn-outline" id="fin-csv" type="button">Выгрузить в Excel (CSV)</button></div>' +
      '<div id="obj-switcher-slot" class="mt-16"></div>' +
      '<div class="card mt-16"><div class="form-row">' +
      '<label class="field"><span>Объект</span><select id="fin-project">' + projectOptions + "</select></label>" +
      '<label class="field"><span>С даты</span><input type="date" id="fin-from" value="' + esc(f.from) + '" /></label>' +
      '<label class="field"><span>По дату</span><input type="date" id="fin-to" value="' + esc(f.to) + '" /></label>' +
      '<label class="field"><span>Тип операции</span><select id="fin-type">' + typeOptions + "</select></label>" +
      '<label class="field"><span>Контрагент</span><input type="text" id="fin-counterparty" value="' +
      esc(f.counterparty) + '" placeholder="ООО «Бетон»" /></label>' +
      '<label class="field"><span>Статус оплаты</span><select id="fin-status">' +
      '<option value="">Все</option>' +
      '<option value="paid"' + (f.status === "paid" ? " selected" : "") + ">Оплачено</option>" +
      '<option value="pending"' + (f.status === "pending" ? " selected" : "") + ">Не оплачено</option>" +
      "</select></label></div></div>" +
      '<div class="grid grid-4 mt-16" id="fin-kpi"></div>' +
      '<div class="card mt-16"><h3>Новая операция</h3><div class="form-row mt-8">' +
      '<label class="field"><span>Дата</span><input type="date" id="fin-new-date" /></label>' +
      '<label class="field"><span>Объект</span><select id="fin-new-project">' +
      '<option value="0">Без объекта</option>' +
      state.finProjects.map(function (row) {
        return '<option value="' + esc(row.id) + '">' + esc(row.name || row.id) + "</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Тип</span><select id="fin-new-type">' +
      FIN_TYPES.map(function (type) { return "<option>" + esc(type) + "</option>"; }).join("") +
      "</select></label>" +
      '<label class="field"><span>Сумма, ₽</span><input type="number" step="0.01" id="fin-new-amount" value="0" /></label>' +
      '<label class="field"><span>Контрагент</span><input type="text" id="fin-new-counterparty" /></label>' +
      '<label class="field"><span>Статус</span><select id="fin-new-status">' +
      '<option value="paid">Оплачено</option><option value="pending">Не оплачено</option></select></label>' +
      '<label class="field"><span>Счёт №</span><input type="text" id="fin-new-doc" /></label>' +
      "</div>" +
      '<label class="field"><span>Комментарий</span><input type="text" id="fin-new-comment" /></label>' +
      // V194.2 (ТЗ §3.2): «Учёт по объекту» — материал сметы или «Сверх сметы».
      '<div class="grid grid-3 mt-8">' +
      '<label class="field"><span>Материал из рабочей сметы</span><select id="fin-new-work-item">' +
      '<option value="">Без привязки</option>' + materialsOptions + "</select></label>" +
      '<label class="field"><span>Количество материала</span>' +
      '<input type="number" step="0.001" id="fin-new-material-qty" /></label>' +
      '<label class="field"><span>Сверх сметы</span><select id="fin-new-off-budget">' +
      '<option value="">—</option><option value="consumables">Расходники / Малоценка</option>' +
      '<option value="extra_works">Допработы</option></select></label>' +
      "</div>" +
      '<button class="btn btn-navy" id="fin-add" type="button">Провести операцию</button></div>' +
      '<div class="card mt-16"><h3>Операции</h3><div id="fin-table" class="mt-8"></div></div>';

    mountObjectSwitcher();
    ["fin-project", "fin-from", "fin-to", "fin-type", "fin-status"].forEach(function (id) {
      var node = $("#" + id);
      if (!node) return;
      node.addEventListener("change", function () {
        var f2 = financeFilters();
        f2.projectId = num($("#fin-project").value);
        f2.from = $("#fin-from").value;
        f2.to = $("#fin-to").value;
        f2.type = $("#fin-type").value;
        f2.status = $("#fin-status").value;
        renderFinanceTable();
      });
    });
    $("#fin-counterparty").addEventListener("input", function () {
      financeFilters().counterparty = $("#fin-counterparty").value.trim().toLowerCase();
      renderFinanceTable();
    });
    $("#fin-add").addEventListener("click", addFinanceOperation);
    $("#fin-csv").addEventListener("click", function () { exportFinanceCsv(); });
    renderFinanceTable();
    } catch (err) {
      // V194.5.5-web (ТЗ §3): вместо вечного спиннера — понятная причина.
      var reason = err && err.message ? err.message : String(err);
      root.innerHTML = '<div class="card"><h3>Финансы не загрузились</h3>' +
        '<div class="warn-box mt-8">' + esc(reason) + "</div>" +
        '<p class="small muted mt-8">Проверьте права на модуль «Финансы» (матрица прав ' +
        "сотрудника). Если ошибка про RLS — попросите руководителя выдать доступ " +
        "can_view_finance_all или can_view_subaccount.</p>" +
        '<div class="flex mt-16"><a class="btn btn-outline" href="#/cabinet">← В Кабинет</a>' +
        '<button class="btn btn-navy" id="fin-retry" type="button">Повторить</button></div></div>';
      var retry = $("#fin-retry");
      if (retry) retry.addEventListener("click", function () { renderFinance(root); });
    } finally {
      // Индикатор загрузки снимается в любом случае (ТЗ §3).
      root.classList.remove("is-loading");
    }
  }

  function filteredFinanceRows() {
    var f = financeFilters();
    return (state.finRows || []).filter(function (row) {
      if (num(f.projectId) && num(row.project_id) !== num(f.projectId)) return false;
      var date = String(row.date || "");
      if (f.from && date < f.from) return false;
      if (f.to && date > f.to) return false;
      if (f.type && String(row.type || "") !== f.type) return false;
      if (f.status && String(row.payment_status || "paid") !== f.status) return false;
      if (f.counterparty) {
        var haystack = (String(row.counterparty || "") + " " +
          String(row.target_user_name || "") + " " + String(row.comment || "")).toLowerCase();
        if (haystack.indexOf(f.counterparty) < 0) return false;
      }
      return true;
    });
  }

  function renderFinanceTable() {
    var rows = filteredFinanceRows();
    var income = 0, expense = 0, pending = 0;
    rows.forEach(function (row) {
      var amount = num(row.amount);
      var type = String(row.type || "");
      if (type === "приход" || type === "аванс") income += amount; else expense += amount;
      if (String(row.payment_status || "paid") !== "paid") pending += amount;
    });
    var kpiBox = $("#fin-kpi");
    if (kpiBox) {
      kpiBox.innerHTML =
        kpi("Приход", money(income), "поступления и авансы") +
        kpi("Расход", money(expense), "оплаты и закрытия") +
        kpi("Остаток", money(income - expense), "сальдо по фильтру") +
        kpi("Неоплаченные счета", money(pending), "ожидают оплаты");
    }
    var box = $("#fin-table");
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state"><p class="small muted">' +
        "Операций по фильтру нет. Добавьте первую операцию — она сразу попадёт в свод.</p>" +
        '<button class="btn btn-navy btn-sm mt-8" id="fin-empty-add" type="button">' +
        "+ Добавить операцию</button></div>";
      var emptyAdd = $("#fin-empty-add");
      if (emptyAdd) emptyAdd.addEventListener("click", function () {
        var form = $("#fin-new-amount");
        if (form && form.scrollIntoView) form.scrollIntoView({ behavior: "smooth", block: "center" });
        if (form) form.focus();
      });
      return;
    }
    box.innerHTML = '<div class="table-wrap" style="max-height:52vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Дата</th><th>Тип</th><th>Объект</th>' +
      '<th>Контрагент</th><th class="num">Сумма, ₽</th><th>Статус</th><th>Документ</th>' +
      "<th>Комментарий</th></tr></thead><tbody>" + rows.map(function (row) {
        var status = String(row.payment_status || "paid");
        var projectName = (state.finProjects || []).filter(function (p) {
          return num(p.id) === num(row.project_id);
        }).map(function (p) { return p.name; })[0] || row.object_name || "—";
        return "<tr><td>" + esc(row.date || "") + "</td><td>" + esc(row.type || "") + "</td>" +
          "<td>" + esc(projectName) + "</td>" +
          "<td>" + esc(row.counterparty || row.target_user_name || "") + "</td>" +
          '<td class="num">' + money(row.amount) + "</td><td>" +
          (status === "paid" ? pill("Оплачено", "ok") : pill("Ожидает", "warn")) + "</td>" +
          "<td>" + esc(row.document_no || "") + "</td>" +
          "<td>" + esc(row.comment || "") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  async function addFinanceOperation() {
    var amount = num($("#fin-new-amount").value);
    if (amount <= 0) { toast("Укажите сумму операции"); return; }
    var workItemId = String($("#fin-new-work-item").value || "").trim();
    var offBudget = String($("#fin-new-off-budget").value || "").trim();
    var materialQty = num($("#fin-new-material-qty").value);
    var res = await sb.from("finance_transactions").insert({
      organization_id: state.orgId,
      project_id: num($("#fin-new-project").value) || null,
      date: $("#fin-new-date").value || new Date().toISOString().slice(0, 10),
      amount: amount,
      type: $("#fin-new-type").value,
      counterparty: $("#fin-new-counterparty").value.trim(),
      payment_status: $("#fin-new-status").value,
      document_no: $("#fin-new-doc").value.trim(),
      comment: $("#fin-new-comment").value.trim(),
      // V194.2 (ТЗ §3.2): привязка к смете / «Сверх сметы».
      work_item_id: workItemId || null,
      material_qty: workItemId && materialQty > 0 ? materialQty : null,
      off_budget_type: offBudget || null,
    });
    if (res.error) { toast("Операция не проведена: " + res.error.message, 6000); return; }
    toast("Операция проведена");
    renderRoute();
  }

  function exportFinanceCsv() {
    var rows = filteredFinanceRows();
    if (!rows.length) { toast("Нет операций для выгрузки"); return; }
    var head = ["Дата", "Тип", "Объект", "Контрагент", "Сумма", "Статус", "Документ", "Комментарий"];
    var lines = [head.join(";")];
    rows.forEach(function (row) {
      var cells = [
        String(row.date || ""), String(row.type || ""), String(row.object_name || ""),
        String(row.counterparty || row.target_user_name || ""),
        String(round2(num(row.amount))).replace(".", ","),
        String(row.payment_status || "paid") === "paid" ? "Оплачено" : "Ожидает",
        String(row.document_no || ""), String(row.comment || ""),
      ].map(function (cell) { return '"' + String(cell).split('"').join('""') + '"'; });
      lines.push(cells.join(";"));
    });
    // BOM + «;» — корректно открывается в русском Excel на Windows.
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "neuroplan_finance_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    toast("CSV выгружен: " + rows.length + " операций");
  }

  // ═════════════════════ V192.4 (Этап 3.2): «Команда» ═════════════════════
  // V193.2: инвайт всегда создаёт «Гостя»; роль директор выдаёт вручную.
  var TEAM_ROLES = [
    { code: "GUEST", title: "Гость" },
    { code: "FOREMAN", title: "Сотрудник / Прораб" },
    { code: "ESTIMATOR", title: "Сметчик" },
    { code: "SUPPLY", title: "Снабженец" },
    { code: "ACCOUNTANT", title: "Бухгалтер" },
    { code: "BRIGADIER", title: "Бригадир" },
  ];

async function renderTeam(root) {
    root.innerHTML = '<div class="muted">Загрузка команды…</div>';
    if (!(await requireAuth(root))) return;
    // V192.9: строгая изоляция — только сотрудники СВОЕЙ организации.
    if (!state.orgId) {
      // V194.5.5-C2 (ТЗ §3): исключённый сотрудник не падает, а видит Демо-режим.
      if (orgMissing()) {
        renderNoOrgMode(root, { title: "Команда доступна только организации" });
      } else {
        root.innerHTML = '<div class="warn-box">Организация не определена: войдите в аккаунт компании.</div>';
      }
      return;
    }
    var res = await sb.from("project_users")
      .select("*")
      .eq("organization_id", state.orgId)
      .order("name", { ascending: true }).limit(500);
    var users = res.data || [];
    var accessRes = await sb.from("profiles")
      // V194.5.5-B2: в profiles есть last_seen_at (last_login_at — нет колонки).
      .select("id, full_name, email, role, account_type, last_seen_at, is_superadmin")
      .eq("organization_id", state.orgId)
      .limit(500);
    var access = accessRes.data || [];
    var orgInvRes = await sb.from("org_invites")
      .select("id, code, role, expires_at, used_by, used_at, is_reusable, created_at")
      .eq("org_id", state.orgId)
      .order("created_at", { ascending: false }).limit(50);
    var orgInvites = orgInvRes.data || [];
    // V194.5.6-C (ТЗ §3): самовосстановление строки руководителя в employees —
    // организация, созданная до релиза, получает директора без перерегистрации.
    await ensureTeamRecord();
    var empRes = await sb.from("employees")
      .select("id, auth_id, full_name, position, email, phone, role, status, " +
        "access_enabled, created_at, updated_at")
      .eq("organization_id", state.orgId)
      .limit(500);
    var employees = empRes.error ? [] : (empRes.data || []);
    // V194.6.5: ФИО руководителя организации — подставляется владельцу, если в
    // employees/profiles записан префикс e-mail (rom61rus вместо фамилии).
    var orgDirRes = await sb.from("organizations")
      .select("director_name").eq("id", state.orgId).maybeSingle();
    var orgDirector = String((orgDirRes.data && orgDirRes.data.director_name) || "").trim();
    // V193.10: одноразовые использованные коды «сгорают» и в активных не показываются.
    var activeInvites = orgInvites.filter(function (row) {
      return !row.used_by || row.is_reusable === true;
    });
    var usedInvites = orgInvites.filter(function (row) {
      return row.used_by && row.is_reusable !== true;
    });
    var ownerEmail = String(state.userEmail || "").toLowerCase();
    var ownerUserId = String(state.userId || "");
    // V194.5.6-C (ТЗ §3): единый список людей = матрица прав (project_users)
    // + реестр сотрудников (employees) + аккаунты (profiles). Директор новой
    // организации учитывается в верхних карточках минимум как 1 / 1.
    var members = mergeTeamMembers(users, employees, access, ownerUserId, ownerEmail, orgDirector);
    var active = members.filter(function (m) { return m.access === true; }).length;

    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Команда</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Сотрудники организации «' + esc(state.orgName || "—") +
      "»: роль, должность, матрица прав и коды приглашений.</p></div>" +
      '<div class="flex">' + (state.isSuper ? pill("Владелец платформы", "ok") : "") + "</div></div>" +
      '<div class="grid grid-4 mt-16">' +
      kpi("Сотрудников", String(members.length), "в организации") +
      kpi("Активный доступ", String(active), "могут входить") +
      kpi("Аккаунтов", String(access.length), "profiles с доступом") +
      kpi("Активных кодов", String(activeInvites.length), "приглашения") +
      "</div>" +
      '<div class="card mt-16"><h3>Пригласить сотрудника в организацию</h3>' +
      '<p class="small muted">Сотрудник при регистрации выбирает «Сотрудник компании» и вводит код — ' +
      "организация и роль подставляются автоматически, ИНН не нужен.</p>" +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Стартовая роль</span>' +
      '<input type="text" value="Гость — права выдаёт руководитель" disabled /></label>' +
      '<label class="field"><span>Действует до</span>' +
      '<input type="date" id="org-invite-expires" /></label>' +
      '<label class="field" style="max-width:220px;"><span>Многоразовый код</span>' +
      '<input type="checkbox" id="org-invite-reusable" style="width:20px;height:20px;" /></label></div>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="org-invite-create" type="button">' +
      'Сгенерировать код</button><span class="small" id="org-invite-result"></span></div>' +
      '<div class="table-wrap mt-8" style="max-height:28vh;overflow:auto;"><table class="data">' +
      "<thead><tr><th>Код</th><th>Тип</th><th>Действует до</th><th>Статус</th><th></th></tr></thead><tbody>" +
      (activeInvites.length ? activeInvites.map(function (row) {
        return "<tr><td><strong>" + esc(row.code) + "</strong></td>" +
          "<td>" + (row.is_reusable ? pill("Многоразовый", "info") : pill("Одноразовый", "warn")) + "</td>" +
          '<td class="small">' + esc(fmtDate(row.expires_at)) + "</td>" +
          "<td>" + pill("Активен", "ok") + "</td>" +
          '<td><button class="btn btn-outline btn-sm" data-org-invite-copy="' + esc(row.code) +
          '" type="button">Скопировать ссылку</button></td></tr>';
      }).join("") : '<tr><td colspan="5" class="muted">Активных кодов нет.</td></tr>') +
      "</tbody></table></div>" +
      (usedInvites.length
        ? '<details class="mt-8"><summary class="small muted">Использованные коды (' +
          usedInvites.length + ")</summary>" +
          '<div class="table-wrap mt-8" style="max-height:22vh;overflow:auto;"><table class="data"><tbody>' +
          usedInvites.map(function (row) {
            return "<tr><td>" + esc(row.code) + '</td><td class="small muted">' +
              esc(fmtDate(row.used_at)) + "</td></tr>";
          }).join("") + "</tbody></table></div></details>"
        : "") +
      "</div>";


    root.innerHTML +=
      '<div class="card mt-16"><h3>Сотрудники: должности и права</h3>' +
      '<p class="small muted">Матрица прав едина для сайта и приложения: выключенный модуль ' +
      "скрывается и в меню, и на телефоне.</p>" +
      '<div class="table-wrap mt-8" style="max-height:56vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Сотрудник</th><th>Контакты</th><th>Должность</th><th>Компания</th>" +
      "<th>Вход и активность</th><th>Действия</th>" +
      "</tr></thead><tbody>" +
      (members.length ? members.map(teamMemberRowHtml).join("")
        : '<tr><td colspan="6" class="muted">Сотрудников пока нет.</td></tr>') +
      "</tbody></table></div></div>";

    var orgInviteBtn = $("#org-invite-create");
    if (orgInviteBtn) orgInviteBtn.addEventListener("click", createOrgInvite);
    $all("[data-org-invite-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        copyOrgInvite(btn.getAttribute("data-org-invite-copy"));
      });
    });
    $all("[data-team-role]").forEach(function (select) {
      if (select.getAttribute("data-owner") === "1") { select.disabled = true; return; }
      select.addEventListener("change", function () {
        saveTeamRole(select.getAttribute("data-team-role"), select.value);
      });
    });
    $all("[data-team-title]").forEach(function (input) {
      // V194.5.6-E (ТЗ §5): поле «Должность» сохраняется кнопкой «Сохранить»,
      // по Enter и по blur — в оба реестра (custom_title + employees.position).
      var save = function () {
        saveTeamTitle(
          input.getAttribute("data-team-title") || "",
          input.value,
          input.getAttribute("data-team-employee") || "",
          input.getAttribute("data-team-auth") || "",
        );
      };
      input.addEventListener("change", save);
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
          input.blur();
        }
      });
    });
    // V194.5.6-E (ТЗ §5): явная кнопка «Сохранить» рядом с должностью.
    $all("[data-team-save]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var wrapper = btn.parentElement;
        var input = wrapper ? wrapper.querySelector("[data-team-title]") : null;
        saveTeamTitle(
          btn.getAttribute("data-team-save") || "",
          input ? input.value : "",
          btn.getAttribute("data-team-save-employee") || "",
          btn.getAttribute("data-team-save-auth") || "",
        );
      });
    });
    $all("[data-team-perms]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openMemberRights(btn.getAttribute("data-team-perms"));
      });
    });
    // V194.5.5-C2 (ТЗ §3): исключение сотрудника — только владелец/директор.
    $all("[data-team-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openRemoveMemberModal({
          rowId: btn.getAttribute("data-team-remove"),
          authId: btn.getAttribute("data-team-remove-auth") || "",
          name: btn.getAttribute("data-team-remove-name") || "Сотрудник",
        });
      });
    });
  }

  /// Модалка подтверждения исключения сотрудника из организации.
  function openRemoveMemberModal(member) {
    if (!canManageOrg()) {
      toast("Исключить сотрудника может только владелец или директор организации");
      return;
    }
    if (member.authId && String(member.authId) === String(state.userId)) {
      toast("Нельзя исключить собственную учётную запись");
      return;
    }
    openModal("Исключение из организации",
      '<p class="small">Сотрудник «' + esc(member.name || "Сотрудник") + '» потеряет доступ к объектам, ' +
      "сметам, финансам и чатам организации. Аккаунт сохранится и перейдёт в Демо-режим " +
      "«Без организации» — вернуться можно только по новому коду приглашения.</p>" +
      '<div class="small" id="rm-member-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="mt-16 flex"><button class="btn btn-danger" id="rm-member-submit" type="button">' +
      "Исключить из организации</button>" +
      '<button class="btn btn-outline" id="rm-member-cancel" type="button">Отмена</button></div>');
    var cancel = $("#rm-member-cancel");
    if (cancel) cancel.addEventListener("click", closeModal);
    var submit = $("#rm-member-submit");
    if (submit) submit.addEventListener("click", function () { removeOrganizationMember(member); });
  }

  /// RPC remove_organization_member: профиль → organization_id NULL, role GUEST.
  async function removeOrganizationMember(member) {
    var btn = $("#rm-member-submit");
    var errorNode = $("#rm-member-error");
    if (btn) { btn.disabled = true; btn.textContent = "Исключаем…"; }
    if (errorNode) errorNode.textContent = "";
    try {
      if (member.authId) {
        var res = await sb.rpc("remove_organization_member", { target_user_id: member.authId });
        if (res.error) throw res.error;
        var payload = res.data || {};
        if (payload && payload.success === false) {
          throw new Error(payload.message || "RPC отклонил операцию");
        }
      } else {
        // Приглашённый без входа: удаляем только строку команды организации.
        var del = await sb.from("project_users").delete()
          .eq("id", num(member.rowId))
          .eq("organization_id", state.orgId);
        if (del.error) throw del.error;
      }
      closeModal();
      toast("Сотрудник исключён из организации");
      renderRoute();
    } catch (e) {
      var text = String((e && e.message) || e);
      var hint = text;
      if (text.indexOf("Недостаточно прав") >= 0) hint = text;
      else if ((e && e.code === "42501") || text.indexOf("permission") >= 0 ||
        text.indexOf("row-level security") >= 0) {
        hint = "недостаточно прав: исключает владелец или директор организации";
      } else if ((e && e.code === "PGRST202") || text.indexOf("Could not find the function") >= 0) {
        hint = "на сервере не применена миграция V194.5.5-C2 (RPC remove_organization_member)";
      }
      var message = "Сотрудник не исключён: " + hint;
      if (errorNode) errorNode.textContent = message;
      else toast(message, 8000);
      if (btn) { btn.disabled = false; btn.textContent = "Исключить из организации"; }
    }
  }




  /// V194.5.6-C (ТЗ §3): самовосстановление строки руководителя в employees.
  /// Один вызов на организацию за сессию: экран «Команда» не показывает 0 / 0
  /// у компании, созданной до релиза V194.5.6-C.
  async function ensureTeamRecord() {
    if (!state.orgId || !state.userId) return false;
    // V194.7.1: во время сохранения регистрации организация ещё пишется
    // (complete_registration) — параллельный ремонт «Команды» создал бы людей
    // в пустой организации-черновике. Ждём завершения регистрации.
    if (registrationInFlight) return false;
    var meta = state.userMeta || {};
    if (meta.pending_registration === true && meta.registration_completed !== true) {
      return false;
    }
    var flag = "np_team_ensured_" + state.orgId;
    try {
      if (sessionStorage.getItem(flag) === "1") return false;
      sessionStorage.setItem(flag, "1");
    } catch (e) { /* приватный режим браузера — просто пробуем */ }
    try {
      var session = (await sb.auth.getSession()).data.session;
      if (!session) return false;
      var base = String(CFG.supabaseUrl || "").replace(/\/$/, "");
      var slug = String(CFG.registrationFunction || "registration-gateway");
      if (!base) return false;
      var resp = await fetch(base + "/functions/v1/" + slug, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: CFG.supabaseAnonKey,
          Authorization: "Bearer " + session.access_token,
        },
        body: JSON.stringify({ action: "ensure_my_employee" }),
      });
      return resp.ok;
    } catch (e) {
      return false;
    }
  }

  /// V194.5.6-C: ФИО-фолбэк — профиль → часть e-mail до @ → «Руководитель».
  function teamDisplayName(name, email, fallback) {
    var text = String(name || "").trim();
    if (text) return text;
    var mail = String(email || "").trim();
    if (mail) {
      var local = mail.indexOf("@") >= 0 ? mail.split("@")[0] : mail;
      if (local) return local;
    }
    return fallback || "Руководитель";
  }
  /// V194.6.5: префикс e-mail до «@» — технический логин, а не ФИО.
  function emailLocalPart(email) {
    var mail = String(email || "").trim().toLowerCase();
    if (!mail) return "";
    return (mail.indexOf("@") >= 0 ? mail.split("@")[0] : mail).trim();
  }
  /// V194.6.5: имя в реестре совпадает с логином (rom61rus) — нужен фолбэк на ФИО.
  function isEmailPrefixName(name, email) {
    var text = String(name || "").trim().toLowerCase();
    var local = emailLocalPart(email);
    return !!text && !!local && text === local;
  }
  /// V194.6.5: не затираем реальное ФИО логином из e-mail при слиянии источников.
  function mergeDisplayName(current, next, email) {
    var nextText = String(next || "").trim();
    var currentText = String(current || "").trim();
    if (!nextText) return currentText;
    if (isEmailPrefixName(nextText, email) && currentText &&
        !isEmailPrefixName(currentText, email)) {
      return currentText;
    }
    return nextText;
  }
  /// V194.5.6-C: слияние project_users + employees + profiles по auth_id/e-mail.
  /// Один человек = одна строка таблицы; доступ и должность берутся из
  /// приоритетного источника (матрица прав → реестр сотрудников → профиль).
  function mergeTeamMembers(users, employees, access, ownerUserId, ownerEmail, orgDirector) {
    var list = [];
    var index = {};
    function keyFor(authId, email) {
      var auth = String(authId || "").trim().toLowerCase();
      if (auth) return "id:" + auth;
      var mail = String(email || "").trim().toLowerCase();
      return mail ? "mail:" + mail : "";
    }
    function ensure(row, source) {
      var key = keyFor(row.auth_id, row.email);
      if (!key) key = source + ":" + (row.id || list.length + 1);
      var member = index[key];
      if (!member) {
        member = {
          key: key, authId: String(row.auth_id || ""), projectUserId: null,
          employeeId: null, profileId: null, name: "", email: "", phone: "",
          roleCode: "", position: "", access: false, lastSeen: "",
          isSuper: false, source: source,
        };
        index[key] = member;
        list.push(member);
      }
      return member;
    }
    (users || []).forEach(function (row) {
      var member = ensure(row, "matrix");
      member.projectUserId = row.id;
      member.name = mergeDisplayName(member.name, row.name || row.full_name,
        row.email || member.email);
      member.email = String(row.email || member.email || "");
      member.phone = String(row.phone || member.phone || "");
      member.roleCode = normalizeRoleCode(row.role) || member.roleCode;
      member.position = String(row.custom_title || row.title || member.position || "");
      var status = String(row.status || "").toLowerCase();
      member.access = member.access || status.indexOf("актив") >= 0 ||
        (!status && !!row.auth_id);
      member.lastSeen = row.last_seen_at || member.lastSeen;
    });
    (employees || []).forEach(function (row) {
      var member = ensure(row, "employee");
      member.employeeId = row.id;
      member.name = mergeDisplayName(member.name, row.full_name, row.email || member.email);
      member.email = String(row.email || member.email || "");
      member.phone = String(row.phone || member.phone || "");
      member.roleCode = normalizeRoleCode(row.role) || member.roleCode;
      // V194.5.6-E (ТЗ §5): своя должность из матрицы прав (custom_title)
      // ПРИОРИТЕТНЕЕ реестра сотрудников — значение не откатывается после F5.
      member.position = String(member.position || row.position || "");
      var active = row.access_enabled !== false &&
        String(row.status || "active").toLowerCase().indexOf("block") < 0;
      member.access = member.access || active;
      member.lastSeen = row.updated_at || row.created_at || member.lastSeen;
    });
    (access || []).forEach(function (row) {
      var profileRow = Object.assign({}, row, { auth_id: row.id });
      var member = ensure(profileRow, "profile");
      member.profileId = row.id;
      member.name = mergeDisplayName(member.name, row.full_name, row.email || member.email);
      member.email = String(row.email || member.email || "");
      member.roleCode = normalizeRoleCode(row.role) || member.roleCode;
      member.access = true;
      member.lastSeen = row.last_seen_at || member.lastSeen;
      member.isSuper = row.is_superadmin === true;
    });
    list.forEach(function (member) {
      member.name = teamDisplayName(member.name, member.email, "Руководитель");
      member.isOwner = (ownerUserId && member.authId === ownerUserId) ||
        (ownerEmail && String(member.email).toLowerCase() === ownerEmail) ||
        member.isSuper === true;
      // V194.6.5: владельцу вместо логина из e-mail — ФИО руководителя
      // организации (как в шапке), оно приоритетнее префикса почты.
      var directorName = String(orgDirector || "").trim();
      if (member.isOwner && directorName && isEmailPrefixName(member.name, member.email)) {
        member.name = directorName;
      }
      if (!member.roleCode) member.roleCode = member.isOwner ? "DIRECTOR" : "GUEST";
      if (!member.position) {
        member.position = member.isOwner ? "Директор" : roleTitle(member.roleCode);
      }
    });
    list.sort(function (a, b) {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), "ru");
    });
    return list;
  }

  /// V194.5.6-C: строка «Сотрудники: должности и права» — ровно 6 ячеек под
  /// 6 заголовков (Сотрудник · Контакты · Должность · Компания · Вход и
  /// активность · Действия).
  function teamMemberRowHtml(memberRow) {
    var member = memberRow || {};
    var isOwner = member.isOwner === true;
    var canRemove = canManageOrg() && !isOwner &&
      String(member.authId || "") !== String(state.userId || "");
    var removeBtn = (canRemove && member.projectUserId)
      ? '<button class="btn btn-danger btn-sm" data-team-remove="' + esc(member.projectUserId) +
        '" data-team-remove-auth="' + esc(member.authId || "") +
        '" data-team-remove-name="' + esc(member.name) +
        '" type="button">Исключить из организации</button>'
      : "";
    var permsBtn = member.projectUserId
      ? '<button class="btn btn-outline btn-sm" data-team-perms="' + esc(member.projectUserId) +
        '" type="button">Права</button>'
      : '<span class="small muted">без матрицы прав</span>';
    var isSelf = String(member.authId || "") === String(state.userId || "");
    // V194.5.6-D (ТЗ §5): должность редактируется всегда — и у владельца/директора.
    var canEditPosition = canManageOrg() || isSelf;
    var positionCell = canEditPosition
      ? '<div class="flex" style="gap:6px;align-items:center;">' +
        '<input type="text" data-team-title="' + esc(member.projectUserId || "") + '"' +
        ' data-team-employee="' + esc(member.employeeId || "") + '"' +
        ' data-team-auth="' + esc(member.authId || "") + '"' +
        ' data-owner="' + (isOwner ? 1 : 0) + '" value="' + esc(member.position) +
        '" placeholder="Должность (своя)" style="min-width:150px;" />' +
        // V194.5.6-E (ТЗ §5): явная кнопка сохранения должности (+ Enter).
        '<button class="btn btn-outline btn-sm" type="button"' +
        ' data-team-save="' + esc(member.projectUserId || "") + '"' +
        ' data-team-save-employee="' + esc(member.employeeId || "") + '"' +
        ' data-team-save-auth="' + esc(member.authId || "") + '">Сохранить</button></div>'
      : esc(member.position || "—");
    var accessPill = member.access
      ? pill("Вход разрешён", "ok") : pill("Без входа", "warn");
    return "<tr><td><strong>" + esc(member.name) + "</strong>" +
      (isOwner ? " " + pill("Владелец", "ok") : "") + "</td>" +
      "<td>" + esc(member.email || "—") +
      (member.phone ? " · " + esc(member.phone) : "") + "</td>" +
      "<td>" + positionCell + "</td>" +
      '<td class="small">' + esc(state.orgName || "—") + "</td>" +
      "<td>" + accessPill + '<div class="small muted">' +
      esc(member.lastSeen ? fmtDate(member.lastSeen) : "активность не зафиксирована") +
      "</div></td>" +
      '<td><div class="flex" style="gap:6px;flex-wrap:wrap;">' +
      permsBtn + removeBtn + "</div></td></tr>";
  }



  /// V194.5.6-D (ТЗ §5): сохранение должности в оба реестра.
  ///
  /// `project_users.custom_title` (матрица прав) и `employees.position` (реестр
  /// команды) — экран «Команда» и мобильное приложение читают один источник.
  /// Для владельца/директора без строки `project_users` обновляется employees.
  async function saveTeamTitle(userId, title, employeeId, authId) {
    var value = String(title || "").trim().slice(0, 80);
    var patched = 0;
    if (num(userId)) {
      var res = await sb.from("project_users")
        .update({ custom_title: value })
        .eq("id", num(userId))
        .eq("organization_id", state.orgId);
      if (res.error) { toast("Должность не сохранена: " + res.error.message, 6000); return; }
      patched++;
    }
    // V194.5.6-E (ТЗ §5): реестр сотрудников обновляется ВСЕГДА (а не только когда
    // строки матрицы прав нет) — иначе после F5 employees.position откатывал
    // сохранённое значение («Директор» → «Прораб»).
    var filters = [];
    if (num(employeeId)) filters.push({ column: "id", value: num(employeeId) });
    if (authId) filters.push({ column: "auth_id", value: String(authId) });
    for (var i = 0; i < filters.length; i++) {
      var empRes = await sb.from("employees")
        .update({ position: value })
        .eq(filters[i].column, filters[i].value)
        .eq("organization_id", state.orgId);
      if (empRes.error) {
        toast("Должность не сохранена: " + empRes.error.message, 6000);
        return;
      }
      patched++;
    }
    if (!patched) { toast("Должность не сохранена: нет строки сотрудника", 6000); return; }
    toast("Должность сохранена: " + (value || "—"));
  }

  /// Модалка матрицы прав: тумблеры по всем модулям (единые для Web и Flutter).
  function openMemberRights(userId) {
    sb.from("project_users").select("*").eq("id", num(userId)).maybeSingle().then(function (res) {
      var row = res.data;
      if (!row) { toast("Сотрудник не найден"); return; }
      // V194.5.6-D (ТЗ §5): защита от снятия прав с самого себя — сотрудник
      // не может лишить себя доступа к «Команде и правам» и выпасть из системы.
      var isSelf = String(row.auth_id || "") === String(state.userId || "");
      var toggles = TEAM_PERMISSIONS.map(function (item) {
        var disabled = isSelf && item[0] === "can_manage_users";
        return '<label class="rights-row"><span>' + esc(item[1]) + "</span>" +
          '<input type="checkbox" data-perm="' + item[0] + '"' +
          (permFromDb(row[item[0]]) || disabled ? " checked" : "") +
          (disabled ? " disabled" : "") + " /></label>";
      }).join("");
      openModal("Права: " + (row.name || row.email || "сотрудник"),
        (isSelf
          ? '<p class="small" style="color:#B45309;">Это ваша учётная запись: ' +
            "право «Команда и права» снять нельзя — иначе вы потеряете доступ " +
            "к управлению организацией.</p>"
          : "") +
        '<p class="small muted">Если модуль выключен — он скрывается в меню сайта и в приложении.</p>' +
        '<div class="rights-grid mt-8">' + toggles + "</div>" +
        '<div class="mt-16 flex"><button class="btn btn-navy" id="perms-save" type="button">' +
        "Сохранить права</button>" +
        '<span class="small muted">Изменения применяются сразу</span></div>');
      $("#perms-save").addEventListener("click", async function () {
        var patch = {};
        $all("[data-perm]").forEach(function (input) {
          var column = input.getAttribute("data-perm");
          // V194.5.2: значения строго по типу колонки (integer 0/1 | boolean).
          patch[column] = permToDb(column, input.checked);
        });
        // V194.5.6-D: нельзя снять с себя управление командой.
        if (isSelf) patch.can_manage_users = permToDb("can_manage_users", true);
        patch.permissions_updated_at = new Date().toISOString();
        var upd = await sb.from("project_users").update(patch).eq("id", num(userId));
        if (upd.error) { toast("Права не сохранены: " + upd.error.message, 7000); return; }
        closeModal();
        toast(isSelf
          ? "Матрица прав обновлена (права на команду сохранены за вами)"
          : "Матрица прав обновлена");
        await loadMyPermissions();
        applyNavPermissions();
      });
    });
  }

  async function saveTeamRole(userId, role) {
    var code = normalizeRoleCode(role);
    var res = await sb.from("project_users").update({ role: code }).eq("id", num(userId));
    if (res.error) { toast("Роль не сохранена: " + res.error.message, 6000); return; }
    toast("Роль обновлена: " + roleTitle(code));
  }



  // ═══════════ V193.10: единая матрица прав (Web ↔ Flutter) ═══════════
  var TEAM_PERMISSIONS = [
    ["can_view_drawings", "Чертежи: просмотр"],
    ["can_edit_drawings", "Чертежи: правка"],
    ["can_delete_drawings", "Чертежи: удаление"],
    ["can_view_reports", "Фотоотчёты: просмотр"],
    ["can_submit_reports", "Фотоотчёты: загрузка"],
    ["can_delete_reports", "Фотоотчёты: удаление"],
    ["can_view_cameras", "LIVE-камеры: просмотр"],
    ["can_manage_cameras", "LIVE-камеры: настройка"],
    ["can_view_estimates", "Сметы и база расценок"],
    ["can_view_finance_all", "Финансы: все операции"],
    ["can_view_subaccount", "Финансы: субсчёт"],
    ["can_edit_gpr", "ГПР / КС-6а"],
    ["can_manage_aosr", "АОСР: ведение"],
    ["can_sign_aosr", "АОСР: подпись"],
    ["can_manage_users", "Команда и права"],
    ["can_view_project_calc", "Расчёт по ПД/РД"],
    ["can_view_work_statement", "Рабочая смета"],
    ["can_view_marketplace", "Биржа подрядов"],
  ];
  // ═══════════ V194.5.2: типы матрицы прав строго по схеме БД ═══════════
  // `project_users.can_*` (15 флагов модулей) — INTEGER (0/1),
  // `can_delete_photos` и `is_superadmin` — BOOLEAN.
  // Отправка `true` в integer-колонку давала PostgREST 22P02
  // «invalid input syntax for type integer: "true"».
  var PERM_BOOLEAN_COLUMNS = { can_delete_photos: true, is_superadmin: true };

  function permToDb(column, checked) {
    return PERM_BOOLEAN_COLUMNS[column] ? !!checked : (checked ? 1 : 0);
  }

  function permFromDb(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value === null || value === undefined) return false;
    var text = String(value).trim().toLowerCase();
    return text === "1" || text === "true" || text === "t" || text === "yes" || text === "on";
  }

  /// Объединение прав сотрудника по всем объектам организации.
  async function loadMyPermissions() {
    state.permissions = {};
    state.canManageTeam = false;
    if (!state.orgId || !state.userId) {
      if (state.isSuper) {
        state.canManageTeam = true;
        TEAM_PERMISSIONS.forEach(function (item) { state.permissions[item[0]] = true; });
      }
      return state.permissions;
    }
    var email = String(state.userEmail || "").toLowerCase();
    var query = sb.from("project_users").select("*").eq("organization_id", state.orgId).limit(200);
    var res = await query;
    var rows = ((res && res.data) || []).filter(function (row) {
      var auth = String(row.auth_id || "");
      var mail = String(row.email || "").toLowerCase();
      return (state.userId && auth === String(state.userId)) || (email && mail === email);
    });
    if (!rows.length && String(roleTitleJs()).indexOf("Руководитель") >= 0) {
      rows = [{ role: "DIRECTOR" }];
    }
    var permissions = {};
    rows.forEach(function (row) {
      TEAM_PERMISSIONS.forEach(function (item) {
        if (permFromDb(row[item[0]])) permissions[item[0]] = true;
      });
      var code = normalizeRoleCode(row.role);
      if (code === "DIRECTOR" || permFromDb(row.is_superadmin)) {
        TEAM_PERMISSIONS.forEach(function (item) { permissions[item[0]] = true; });
      }
    });
    state.permissions = permissions;
    state.canManageTeam = state.isSuper || permissions.can_manage_users === true;
    return permissions;
  }

  function can(flag) {
    if (state.isSuper) return true;
    return !!(state.permissions && state.permissions[flag]);
  }

  /// Скрывает пункты меню, на которые у сотрудника нет прав.
  function applyNavPermissions() {
    // V194.5.5-web: в шапке только сквозные разделы — модули живут в Кабинете.
    var map = {
      "nav-cabinet": true,
      "nav-chat": true,
      "nav-org": true,
      "nav-marketplace": can("can_view_marketplace") || state.isSuper,
      "nav-admin": state.isSuper,
    };
    Object.keys(map).forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.style.display = map[id] ? "" : "none";
    });
  }

  async function renderPhotoReports(root) {
    root.innerHTML = '<div class="muted">Загрузка фотоотчётов…</div>';
    if (!(await requireAuth(root))) return;
    var res = await sb.from("project_media").select("*")
      .order("capture_date", { ascending: false }).limit(400);
    if (res.error) {
      root.innerHTML = '<div class="warn-box">Не удалось прочитать фотоотчёты: ' +
        esc(res.error.message) + "</div>";
      return;
    }
    state.mediaRows = res.data || [];
    var projectsRes = await sb.from("projects").select("id, name").order("name").limit(200);
    state.mediaProjects = projectsRes.data || [];
    var f = state.mediaFilters || (state.mediaFilters = { projectId: 0, stage: "", date: "" });
    var stages = {};
    state.mediaRows.forEach(function (row) {
      var stage = String(row.stage_name || "").trim();
      if (stage) stages[stage] = true;
    });
    var projectOptions = '<option value="0">Все объекты</option>' +
      state.mediaProjects.map(function (row) {
        return '<option value="' + esc(row.id) + '"' +
          (num(row.id) === num(f.projectId) ? " selected" : "") + ">" +
          esc(row.name || row.id) + "</option>";
      }).join("");
    var stageOptions = '<option value="">Все виды работ</option>' +
      Object.keys(stages).map(function (stage) {
        return '<option value="' + esc(stage) + '"' + (f.stage === stage ? " selected" : "") +
          ">" + esc(stage) + "</option>";
      }).join("");

    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Фотоотчёты</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Фотофиксация стройплощадки: объект, вид работ, дата.</p></div>' +
      '<label class="btn btn-navy" for="media-file" style="cursor:pointer;">Загрузить фото</label>' +
      '<input id="media-file" type="file" accept="image/*" multiple class="hidden" /></div>' +
      '<div class="card mt-16"><div class="form-row">' +
      '<label class="field"><span>Объект</span><select id="media-project">' + projectOptions + "</select></label>" +
      '<label class="field"><span>Вид работ</span><select id="media-stage">' + stageOptions + "</select></label>" +
      '<label class="field"><span>Дата</span><input type="date" id="media-date" value="' + esc(f.date) + '" /></label>' +
      "</div></div>" +
      '<div id="media-grid" class="mt-16"></div>';

    ["media-project", "media-stage", "media-date"].forEach(function (id) {
      $("#" + id).addEventListener("change", function () {
        f.projectId = num($("#media-project").value);
        f.stage = $("#media-stage").value;
        f.date = $("#media-date").value;
        renderMediaGrid();
      });
    });
    $("#media-file").addEventListener("change", uploadMediaFiles);
    renderMediaGrid();
  }

  function filteredMediaRows() {
    var f = state.mediaFilters || {};
    return (state.mediaRows || []).filter(function (row) {
      if (num(f.projectId) && num(row.project_id) !== num(f.projectId)) return false;
      if (f.stage && String(row.stage_name || "") !== f.stage) return false;
      if (f.date && !String(row.capture_date || "").startsWith(f.date)) return false;
      return true;
    });
  }

  function renderMediaGrid() {
    var box = $("#media-grid");
    if (!box) return;
    var rows = filteredMediaRows();
    if (!rows.length) {
      box.innerHTML = '<p class="small muted">Фотографий по фильтру нет.</p>';
      return;
    }
    box.innerHTML = '<div class="grid grid-3">' + rows.map(function (row) {
      var src = String(row.remote_url || "").trim();
      var projectName = (state.mediaProjects || []).filter(function (p) {
        return num(p.id) === num(row.project_id);
      }).map(function (p) { return p.name; })[0] || "Объект";
      return '<div class="card" style="padding:10px;">' +
        '<div data-media-open="' + esc(row.id) + '" style="cursor:zoom-in;">' +
        (src ? '<img src="' + esc(src) + '" alt="" style="width:100%;height:150px;object-fit:cover;border-radius:10px;" />' :
          '<div class="warn-box">Файл не загружен в облако</div>') + "</div>" +
        '<div class="small mt-8"><strong>' + esc(projectName) + "</strong> · " +
        esc(row.stage_name || "без этапа") + "</div>" +
        '<div class="small muted">' + esc(String(row.capture_date || "").slice(0, 16).replace("T", " ")) +
        (row.author_name ? " · " + esc(row.author_name) : "") + "</div>" +
        (row.comment ? '<div class="small mt-8">' + esc(row.comment) + "</div>" : "") +
        "</div>";
    }).join("") + "</div>";

    $all("[data-media-open]", box).forEach(function (el) {
      el.addEventListener("click", function () {
        var row = rows.find(function (item) {
          return String(item.id) === el.getAttribute("data-media-open");
        });
        if (row) openMediaLightbox(row);
      });
    });
  }

  function openMediaLightbox(row) {
    var src = String(row.remote_url || "").trim();
    openModal(row.stage_name || "Фотоотчёт",
      (src ? '<img src="' + esc(src) + '" alt="" style="width:100%;border-radius:12px;" />' : "") +
      '<div class="mt-16 small">' + esc(String(row.capture_date || "").replace("T", " ")) +
      (row.author_name ? " · " + esc(row.author_name) : "") + "</div>" +
      (row.comment ? '<div class="mt-8">' + esc(row.comment) + "</div>" : ""));
  }

  async function uploadMediaFiles(event) {
    var files = event.target.files;
    if (!files || !files.length) return;
    if (!state.orgId) { toast("Организация не определена — перезайдите в аккаунт"); return; }
    var projectId = num(state.mediaFilters && state.mediaFilters.projectId) || 0;
    var stage = ($("#media-stage") && $("#media-stage").value) || "Ход строительства";
    var uploaded = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var path = state.orgId + "/" + Date.now() + "_" + (i + 1) + "_" + sanitizeStorageKey(file.name);
      var up = await sb.storage.from("project_media")
        .upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (up.error) { toast("Фото не загружено: " + up.error.message, 6000); continue; }
      var signed = await sb.storage.from("project_media")
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      var ins = await sb.from("project_media").insert({
        project_id: projectId || null,
        organization_id: state.orgId,
        file_path: path,
        remote_url: signed.error ? "" : signed.data.signedUrl,
        media_type: "photo",
        stage_name: stage,
        capture_date: new Date().toISOString(),
        comment: "",
        author_name: (state.profile && (state.profile.full_name || state.profile.role)) || "Портал",
        author_id: state.userId,
      });
      if (ins.error) { toast("Запись не создана: " + ins.error.message, 6000); continue; }
      uploaded += 1;
    }
    event.target.value = "";
    if (uploaded) toast("Загружено фото: " + uploaded);
    renderRoute();
  }

  // ═══════════════ V192.4 (Этап 3.4): «Штаб стройки» — чат объектов ═══════════════
  function siteChannel(projectId) {
    return "project:" + projectId;
  }

  /// Активный канал «Штаба стройки» (тред из настроек или канал объекта).
  function activeChatChannel() {
    return String(state.chatChannelName || "").trim() || siteChannel(state.chatProjectId);
  }

  /// Все чаты организации: настройки (chat_threads) + каналы из истории сообщений.
  async function loadChatChannels() {
    var threads = [];
    try {
      var res = await sb.from("chat_threads").select("*")
        .eq("org_id", state.orgId).order("title", { ascending: true }).limit(100);
      threads = res.data || [];
    } catch (e) { threads = []; }
    var channels = {};
    try {
      var msgs = await sb.from("chat_messages").select("channel")
        .eq("organization_id", state.orgId).limit(2000);
      (msgs.data || []).forEach(function (row) {
        var name = String(row.channel || "").trim();
        if (name && name.indexOf("project:") !== 0) channels[name] = true;
      });
    } catch (e) { /* история может быть пуста */ }
    return { threads: threads, channels: Object.keys(channels).sort() };
  }

  async function renderSiteChat(root) {
    root.innerHTML = '<div class="muted">Загрузка штаба стройки…</div>';
    if (!(await requireAuth(root))) return;
    markChatRead();
    if (!(state.projects || []).length) await loadProjectsList();
    var projects = state.projects || [];
    if (!projects.length) {
      root.innerHTML = '<div class="warn-box">В организации ещё нет объектов. ' +
        'Создайте объект — появится канал «Штаба стройки».</div>';
      return;
    }
    state.chatProjects = projects;
    state.chatProjectId = num(state.chatProjectId) || num(projects[0].id);
    var chatData = await loadChatChannels();
    state.chatThreads = chatData.threads;
    state.chatChannels = chatData.channels;

    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Штаб стройки</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Все чаты организации (те же таблицы, что в приложении) ' +
      "и каналы объектов.</p></div>" +
      '<button class="btn btn-outline btn-sm" id="chat-new" type="button">+ Новый чат</button></div>' +
      '<div id="obj-switcher-slot" class="mt-16"></div>' +
      '<div class="grid mt-16" style="grid-template-columns:minmax(230px,300px) 1fr;">' +
      '<div class="card" id="chat-projects" style="padding:10px;"></div>' +
      '<div class="card" style="padding:12px;display:flex;flex-direction:column;min-height:60vh;">' +
      '<div class="flex-between"><strong class="small" id="chat-current"></strong>' +
      '<div class="flex">' +
      ((can("can_manage_users") || state.isSuper)
        ? '<button class="btn btn-danger btn-sm" id="chat-delete" type="button">Удалить чат</button>'
        : "") +
      '<button class="btn btn-outline btn-sm" id="chat-settings" type="button">Настройки</button>' +
      "</div></div>" +
      '<div id="chat-feed" style="flex:1;overflow:auto;max-height:52vh;" class="mt-8"></div>' +
      '<div class="flex mt-8">' +
      '<input type="text" id="chat-text" placeholder="Сообщение в чат…" style="flex:1;" />' +
      '<label class="btn btn-outline" for="chat-file" style="cursor:pointer;">Файл</label>' +
      '<input id="chat-file" type="file" class="hidden" />' +
      '<button class="btn btn-navy" id="chat-send" type="button">Отправить</button>' +
      "</div></div></div>";

    renderChatSidebar(projects);
    mountObjectSwitcher();
    $("#chat-new").addEventListener("click", function () { openChatSettings(null); });
    $("#chat-settings").addEventListener("click", function () { openChatSettings(activeChatThread()); });
    var chatDeleteBtn = $("#chat-delete");
    if (chatDeleteBtn) chatDeleteBtn.addEventListener("click", deleteChatThread);
    $("#chat-send").addEventListener("click", sendChatMessage);
    $("#chat-file").addEventListener("change", sendChatFile);
    $("#chat-text").addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); sendChatMessage(); }
    });
    await loadChatMessages();
    subscribeProjectChat();
  }

  function activeChatThread() {
    var name = String(state.chatChannelName || "").trim();
    return (state.chatThreads || []).filter(function (row) {
      return String(row.title) === name;
    })[0] || null;
  }

  function renderChatSidebar(projects) {
    var box = $("#chat-projects");
    if (!box) return;
    var current = activeChatChannel();
    var threads = state.chatThreads || [];
    var channels = state.chatChannels || [];
    var html = '<div class="small muted" style="padding:4px 8px;">Чаты организации</div>';
    html += threads.map(function (thread) {
      var members = Array.isArray(thread.members) ? thread.members.length : 0;
      return '<div data-chat-channel="' + esc(thread.title) + '" style="cursor:pointer;padding:8px;border-radius:9px;' +
        (current === String(thread.title) ? "background:#DCE6F1;font-weight:800;" : "") + '">' +
        esc(thread.title) + '<div class="small muted">' + members + " участн.</div></div>";
    }).join("");
    html += channels.map(function (name) {
      return '<div data-chat-channel="' + esc(name) + '" style="cursor:pointer;padding:8px;border-radius:9px;' +
        (current === name ? "background:#DCE6F1;font-weight:800;" : "") + '">' + esc(name) + "</div>";
    }).join("");
    html += '<div class="small muted" style="padding:10px 8px 4px;">Объекты</div>';
    html += projects.map(function (row) {
      var channel = siteChannel(row.id);
      var active = current === channel;
      return '<div data-chat-channel="' + esc(channel) + '" data-chat-project="' + esc(row.id) +
        '" style="cursor:pointer;padding:8px;border-radius:9px;' +
        (active ? "background:#DCE6F1;font-weight:800;" : "") + '">' +
        esc(row.name || ("Объект " + row.id)) + "</div>";
    }).join("");
    box.innerHTML = html;
    var currentLabel = $("#chat-current");
    if (currentLabel) {
      currentLabel.textContent = current.indexOf("project:") === 0 ? "Канал объекта" : current;
    }
    $all("[data-chat-channel]", box).forEach(function (node) {
      node.addEventListener("click", function () {
        state.chatChannelName = node.getAttribute("data-chat-channel");
        if (node.getAttribute("data-chat-project")) {
          state.chatProjectId = num(node.getAttribute("data-chat-project"));
        }
        renderSiteChat($("#app"));
      });
    });
  }

  /// Настройки чата: создание, переименование, участники из команды.
  async function openChatSettings(thread) {
    var isEdit = !!thread;
    var members = isEdit && Array.isArray(thread.members) ? thread.members.slice() : [];
    var usersRes = await sb.from("project_users").select("id, name, email")
      .eq("organization_id", state.orgId).limit(300);
    var users = usersRes.data || [];
    var rows = users.map(function (user) {
      var label = user.name || user.email || ("Сотрудник " + user.id);
      return '<label class="rights-row"><span>' + esc(label) + "</span>" +
        '<input type="checkbox" data-member="' + esc(label) + '"' +
        (members.indexOf(label) >= 0 ? " checked" : "") + " /></label>";
    }).join("");
    openModal(isEdit ? "Настройки чата" : "Новый чат",
      '<label class="field"><span>Название чата</span>' +
      '<input type="text" id="chat-title" value="' + esc(isEdit ? thread.title : "") +
      '" placeholder="Штаб объекта · неделя 12" /></label>' +
      '<div class="small muted mt-8">Участники из команды:</div>' +
      '<div class="rights-grid mt-8">' +
      (rows || '<span class="small muted">В команде пока нет сотрудников</span>') + "</div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="chat-save" type="button">' +
      (isEdit ? "Сохранить" : "Создать чат") + "</button>" +
      (isEdit ? '<button class="btn btn-outline" id="chat-del" type="button">Удалить чат</button>' : "") +
      "</div>");
    $("#chat-save").addEventListener("click", async function () {
      var title = String($("#chat-title").value || "").trim();
      if (!title) { toast("Укажите название чата"); return; }
      var list = [];
      $all("[data-member]").forEach(function (input) {
        if (input.checked) list.push(input.getAttribute("data-member"));
      });
      var payload = {
        org_id: state.orgId, title: title, members: list, created_by: state.userId || null,
      };
      var res = isEdit
        ? await sb.from("chat_threads").update({ title: title, members: list }).eq("id", thread.id)
        : await sb.from("chat_threads").insert(payload);
      if (res.error) { toast("Чат не сохранён: " + res.error.message, 7000); return; }
      state.chatChannelName = title;
      closeModal();
      toast(isEdit ? "Чат обновлён" : "Чат создан: " + title);
      renderSiteChat($("#app"));
    });
    var del = $("#chat-del");
    if (del) {
      del.addEventListener("click", async function () {
        if (!window.confirm("Удалить чат «" + thread.title + "»? Сообщения останутся в архиве.")) return;
        var res = await sb.from("chat_threads").delete().eq("id", thread.id);
        if (res.error) { toast("Чат не удалён: " + res.error.message, 7000); return; }
        state.chatChannelName = "";
        closeModal();
        toast("Чат удалён");
        renderSiteChat($("#app"));
      });
    }
  }

  async function loadChatMessages() {
    var feed = $("#chat-feed");
    if (!feed) return;
    var channel = activeChatChannel();
    var res = await sb.from("chat_messages").select("*")
      .eq("organization_id", state.orgId)
      .eq("channel", channel).order("created_at", { ascending: true }).limit(200);
    if (res.error) {
      feed.innerHTML = '<div class="warn-box">Не удалось прочитать ленту: ' +
        esc(res.error.message) + "</div>";
      return;
    }
    state.chatRows = res.data || [];
    renderChatFeed();
  }

  function renderChatFeed() {
    var feed = $("#chat-feed");
    if (!feed) return;
    var rows = state.chatRows || [];
    if (!rows.length) {
      feed.innerHTML = '<p class="small muted">Сообщений пока нет — начните обсуждение объекта.</p>';
      return;
    }
    var canManage = can("can_manage_users") || state.isSuper;
    feed.innerHTML = rows.map(function (row) {
      var isMine = String(row.sender_id || "") === String(state.userId) ||
        (row.sender_id == null &&
          String(row.sender_name || "").toLowerCase() ===
            String(((state.profile && state.profile.full_name) || "")).toLowerCase());
      var attachment = String(row.photo_path || "").trim();
      var imageHtml = attachment && chatFileIsImage(attachment)
        ? '<div class="mt-8 chat-image" data-chat-image="' + esc(attachment) + '"></div>'
        : "";
      var fileHtml = attachment
        ? '<div class="mt-8"><button class="btn btn-outline btn-sm" data-chat-file-open="' +
          esc(attachment) + '">' + (chatFileIsImage(attachment) ? "Открыть фото" : "Открыть файл") +
          "</button></div>"
        : "";
      return '<div class="chat-msg' + (isMine ? " is-mine" : "") + '">' +
        '<div class="flex-between"><div class="small"><strong>' +
        esc(row.sender_name || "Сотрудник") + "</strong>" +
        ' <span class="muted">' +
        esc(String(row.timestamp || row.created_at || "").slice(0, 16).replace("T", " ")) +
        "</span></div>" +
        ((isMine || canManage)
          ? '<button class="chat-del" data-chat-del="' + esc(row.id) +
            '" type="button" title="Удалить сообщение">✕</button>'
          : "") +
        "</div>" +
        (row.message ? '<div class="mt-8">' + esc(row.message) + "</div>" : "") +
        imageHtml + fileHtml +
        "</div>";
    }).join("");
    feed.scrollTop = feed.scrollHeight;
    $all("[data-chat-file-open]", feed).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openChatAttachment(btn.getAttribute("data-chat-file-open"));
      });
    });
    // Превью картинок любого формата (.jfif/.webp/.jpg/.jpeg/.png/.gif).
    $all("[data-chat-image]", feed).forEach(function (node) {
      var path = node.getAttribute("data-chat-image");
      sb.storage.from("chat_files").createSignedUrl(path, 3600).then(function (signed) {
        if (!node.isConnected) return;
        if (signed.error || !signed.data) {
          node.innerHTML = '<span class="small muted">Вложение недоступно</span>';
          return;
        }
        var img = document.createElement("img");
        img.src = signed.data.signedUrl;
        img.alt = "Вложение";
        img.className = "chat-thumb";
        img.addEventListener("click", function () { openChatAttachment(path); });
        node.innerHTML = "";
        node.appendChild(img);
      }).catch(function () {
        node.innerHTML = '<span class="small muted">Вложение недоступно</span>';
      });
    });
    $all("[data-chat-del]", feed).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-chat-del");
        var row = (state.chatRows || []).filter(function (item) {
          return String(item.id) === String(id);
        })[0];
        if (row) deleteChatMessage(row);
      });
    });
  }

  /// Realtime строго по конкретному объекту: фильтр channel=eq.project:<id>.
  function subscribeProjectChat() {
    if (state.chatChannel) {
      try { state.chatChannel.unsubscribe(); } catch (e) {}
      state.chatChannel = null;
    }
    var channel = activeChatChannel();
    try {
      state.chatChannel = sb.channel("site-chat-" + sanitizeStorageKey(channel))
        .on("postgres_changes", {
          event: "INSERT", schema: "public", table: "chat_messages",
          filter: "channel=eq." + channel,
        }, function (payload) {
          if (!payload || !payload.new) return;
          state.chatRows = (state.chatRows || []).concat([payload.new]);
          renderChatFeed();
        })
        .subscribe();
    } catch (e) { /* без Realtime лента обновится при следующем входе */ }
  }

  async function sendChatMessage() {
    var input = $("#chat-text");
    if (!input) return;
    var text = input.value.trim();
    if (!text) { toast("Введите текст сообщения"); return; }
    input.value = "";
    var res = await sb.from("chat_messages").insert({
      organization_id: state.orgId,
      channel: activeChatChannel(),
      sender_id: state.userId,
      sender_name: (state.profile && (state.profile.full_name || state.profile.role)) || "Портал",
      sender_role: (state.profile && state.profile.role) || "Сотрудник",
      message: text,
      timestamp: new Date().toISOString(),
    });
    if (res.error) { toast("Сообщение не отправлено: " + res.error.message, 6000); return; }
  }

  async function sendChatFile(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    var path = state.orgId + "/" + Date.now() + "_" + sanitizeStorageKey(file.name);
    var up = await sb.storage.from("chat_files")
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (up.error) { toast("Файл не загружен: " + up.error.message, 6000); return; }
    var res = await sb.from("chat_messages").insert({
      organization_id: state.orgId,
      channel: activeChatChannel(),
      sender_id: state.userId,
      sender_name: (state.profile && (state.profile.full_name || state.profile.role)) || "Портал",
      sender_role: (state.profile && state.profile.role) || "Сотрудник",
      message: "Файл: " + file.name,
      photo_path: path,
      timestamp: new Date().toISOString(),
    });
    event.target.value = "";
    if (res.error) { toast("Файл загружен, но сообщение не создано: " + res.error.message, 6000); }
  }

  // ═════════ V194.5.5-B (ТЗ §2–§3): переписка по Бирже и удаление в чате ═════════

  function updateMarketBadge(count) {
    state.marketUnread = Math.max(0, num(count));
    var node = $("#nav-mp-count");
    if (!node) return;
    if (state.marketUnread > 0) {
      node.textContent = state.marketUnread > 99 ? "99+" : String(state.marketUnread);
      node.classList.remove("hidden");
    } else {
      node.textContent = "0";
      node.classList.add("hidden");
    }
  }

  /// Счётчик непрочитанных откликов по объявлениям Биржи (не чаще 15 секунд).
  async function refreshMarketplaceUnread() {
    if (!state.userId) { updateMarketBadge(0); return 0; }
    if (Date.now() - num(state.marketUnreadAt) < 15000) return state.marketUnread;
    state.marketUnreadAt = Date.now();
    try {
      var res = await sb.from("marketplace_messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", state.userId)
        .eq("is_read", false);
      if (res && !res.error) updateMarketBadge(num(res.count));
    } catch (e) { /* счётчик не должен ломать портал */ }
    return state.marketUnread;
  }

  function marketMessageRowHtml(row) {
    var mine = String(row.sender_id) === String(state.userId);
    return '<div class="mp-msg' + (mine ? " is-mine" : "") + '">' +
      '<div class="small muted">' + esc(fmtDate(row.created_at)) +
      (mine ? " · вы" : "") + "</div>" +
      '<div class="mt-8">' + esc(row.body || "") + "</div></div>";
  }

  /// Отметить входящие отклики по объявлению прочитанными.
  async function markMarketplaceThreadRead(post) {
    if (!post || !state.userId) return;
    try {
      await sb.from("marketplace_messages")
        .update({ is_read: true })
        .eq("listing_id", post.id)
        .eq("recipient_id", state.userId)
        .eq("is_read", false);
      refreshMarketplaceUnread();
    } catch (e) { /* отметка прочтения не критична */ }
  }

  /// Переписка по объявлению: автор отвечает откликнувшимся, остальные — автору.
  async function openMarketplaceChat(post) {
    if (!post) return;
    if (!state.userId) { toast("Войдите, чтобы написать по объявлению"); return; }
    var mine = String(post.author_user_id) === String(state.userId);
    var rows = [];
    try {
      var res = await sb.from("marketplace_messages").select("*")
        .eq("listing_id", post.id)
        .order("created_at", { ascending: true })
        .limit(300);
      if (!res.error) rows = res.data || [];
    } catch (e) { rows = []; }
    var visible = rows.filter(function (row) {
      return mine
        || String(row.sender_id) === String(state.userId)
        || String(row.recipient_id) === String(state.userId);
    });
    var peerId = mine
      ? (visible.length ? String(visible[visible.length - 1].sender_id) : "")
      : String(post.author_user_id);
    var feed = visible.length
      ? visible.map(marketMessageRowHtml).join("")
      : '<p class="small muted">Сообщений пока нет. Переписка видна только участникам.</p>';
    openModal("Переписка по объявлению",
      '<div class="small muted">' + esc(post.title || "Объявление") + "</div>" +
      (mine
        ? '<div class="small muted mt-8">Вы автор: отвечаете откликнувшимся. ' +
          "Сообщений в переписке: " + visible.length + "</div>"
        : "") +
      '<div class="mp-thread mt-16" id="mp-thread">' + feed + "</div>" +
      '<label class="field mt-16"><span>Сообщение</span>' +
      '<textarea id="mp-msg-text" rows="2" placeholder="Здравствуйте! Интересует объём работ…"></textarea>' +
      "</label>" +
      '<div class="flex mt-8"><button class="btn btn-navy" id="mp-msg-send" type="button">Отправить</button>' +
      // V194.5.6-D (ТЗ §5): удаление переписки доступно обеим сторонам диалога.
      '<button class="btn btn-outline btn-sm" id="mp-thread-delete" type="button">' +
      "Удалить чат</button>" +
      '<span class="small muted" id="mp-msg-status"></span></div>');
    await markMarketplaceThreadRead(post);
    var sendBtn = $("#mp-msg-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", function () { sendMarketplaceMessage(post, peerId); });
    }
    var deleteBtn = $("#mp-thread-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function () {
        deleteMarketplaceThread(post);
      });
    }
    var feedNode = $("#mp-thread");
    if (feedNode) feedNode.scrollTop = feedNode.scrollHeight;
  }

  /// V194.5.6-D (ТЗ §5): удаление переписки по объявлению (с подтверждением).
  async function deleteMarketplaceThread(post) {
    if (!post || !state.userId) return;
    if (!window.confirm("Удалить чат по объявлению «" +
        String(post.title || "") + "» со всеми сообщениями? Действие необратимо.")) return;
    try {
      var res = await sb.from("marketplace_messages").delete()
        .eq("listing_id", post.id);
      if (res.error) throw res.error;
      toast("Чат удалён");
      closeModal();
      refreshMarketplaceUnread();
      if (typeof renderRoute === "function") renderRoute();
    } catch (e) {
      toast("Чат не удалён: " + ((e && e.message) || e), 8000);
    }
  }


  async function sendMarketplaceMessage(post, recipientId) {
    if (!post) return;
    var input = $("#mp-msg-text");
    var status = $("#mp-msg-status");
    var body = input ? String(input.value || "").trim() : "";
    if (!body) { toast("Введите текст сообщения"); return; }
    var mine = String(post.author_user_id) === String(state.userId);
    var target = String(recipientId || (mine ? "" : post.author_user_id) || "");
    if (!target) { toast("Пока нет откликов — отвечать некому"); return; }
    var button = $("#mp-msg-send");
    if (button) { button.disabled = true; button.textContent = "Отправляем…"; }
    try {
      var res = await sb.from("marketplace_messages").insert({
        listing_id: post.id,
        sender_id: state.userId,
        sender_org_id: state.orgId || null,
        recipient_id: target,
        body: body,
        is_read: false,
      });
      if (res.error) throw res.error;
      if (status) status.textContent = "";
      await openMarketplaceChat(post);
      refreshMarketplaceUnread();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      toast("Сообщение не отправлено: " + message, 8000);
    } finally {
      if (button) { button.disabled = false; button.textContent = "Отправить"; }
    }
  }

  /// Картинка ли это (расширение регистронезависимо: .jfif/.webp/.jpg/.jpeg/.png/.gif).
  function chatFileIsImage(path) {
    var clean = String(path || "").split("?")[0].toLowerCase();
    return /\.(jpe?g|jfif|png|gif|webp|bmp|heic|heif)$/.test(clean);
  }

  async function openChatAttachment(path) {
    if (!path) return;
    var signed = await sb.storage.from("chat_files").createSignedUrl(path, 3600);
    if (signed.error) { toast("Файл недоступен: " + signed.error.message); return; }
    var url = signed.data.signedUrl;
    if (chatFileIsImage(path)) {
      openModal("Вложение",
        '<img src="' + esc(url) + '" alt="Вложение" style="width:100%;border-radius:12px;" />' +
        '<div class="mt-8"><a class="btn btn-outline btn-sm" href="' + esc(url) +
        '" target="_blank" rel="noopener">Открыть оригинал</a></div>');
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  /// Удаление сообщения: автор — своё, руководитель/суперадмин — любое.
  async function deleteChatMessage(row) {
    if (!row || row.id == null) return;
    if (!window.confirm("Удалить сообщение из чата?")) return;
    var res = await sb.from("chat_messages").delete().eq("id", row.id);
    if (res.error) { toast("Не удалено: " + res.error.message, 8000); return; }
    state.chatRows = (state.chatRows || []).filter(function (item) {
      return String(item.id) !== String(row.id);
    });
    renderChatFeed();
    toast("Сообщение удалено");
  }

  /// Удаление чата целиком (руководитель организации / суперадмин).
  async function deleteChatThread() {
    var channel = activeChatChannel();
    var thread = activeChatThread();
    if (!channel && !thread) { toast("Чат не выбран"); return; }
    if (!window.confirm("Удалить чат «" + (channel || thread.title) + "» со всеми сообщениями?")) return;
    try {
      if (thread && thread.id) {
        var delThread = await sb.from("chat_threads").delete().eq("id", thread.id);
        if (delThread.error) throw delThread.error;
      }
      if (channel && channel.indexOf("project:") !== 0) {
        await sb.from("chat_channels").delete()
          .eq("organization_id", state.orgId).eq("name", channel);
        var delMsgs = await sb.from("chat_messages").delete()
          .eq("organization_id", state.orgId).eq("channel", channel);
        if (delMsgs.error) throw delMsgs.error;
      }
      state.chatChannelName = "";
      state.chatRows = [];
      toast("Чат удалён");
      renderRoute();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      toast("Чат не удалён: " + message, 8000);
    }
  }

  // ─────────────────────────────── Роутер ───────────────────────────────
  // ═══════════ V192.7 (Спринт 2): управление организациями ═══════════
  // V194.6.0 (ТЗ §1): единая матрица тарифов портала. Цифры совпадают с
  // public.tariff_plans (миграция 20261144) — источник истины в БД.
  var TARIFF_MATRIX = [
    { code: "trial", title: "Триал", audience: "Знакомство с платформой на реальном объекте",
      price: 0, yearlyMonthly: 0, yearlyTotal: 0, trialDays: 10,
      objects: 1, employees: 2, priceBook: 10, estimates: 2, pd: 1, chat: 15,
      ocr: 5, legal: 3, marketplace: 0, cameras: 0, storageGb: 0.2,
      aiReset: 0, extraGbPrice: 0, customDev: false, chatUnlimited: false },
    { code: "start", title: "Старт", audience: "Частные мастера и небольшие бригады",
      price: 2490, yearlyMonthly: 1992, yearlyTotal: 23904, trialDays: 0,
      objects: 2, employees: 3, priceBook: 30, estimates: 5, pd: 3, chat: 30,
      ocr: 20, legal: 10, marketplace: 1, cameras: 1, storageGb: 1,
      aiReset: 500, extraGbPrice: 50, customDev: false, chatUnlimited: false },
    { code: "small_business", title: "Малый бизнес", audience: "Подрядные организации с несколькими объектами",
      price: 4490, yearlyMonthly: 3592, yearlyTotal: 43104, trialDays: 0,
      objects: 5, employees: 15, priceBook: 200, estimates: 20, pd: 10, chat: 150,
      ocr: 100, legal: 40, marketplace: 3, cameras: 2, storageGb: 5,
      aiReset: 1500, extraGbPrice: 50, customDev: false, chatUnlimited: false },
    { code: "general_contractor", title: "Генподрядчик", audience: "Генподряд и техзаказчик на крупных стройках",
      price: 8990, yearlyMonthly: 7192, yearlyTotal: 86304, trialDays: 0,
      objects: 15, employees: 50, priceBook: -1, estimates: 60, pd: 30, chat: 500,
      ocr: 300, legal: 120, marketplace: 15, cameras: 4, storageGb: 20,
      aiReset: 3500, extraGbPrice: 50, customDev: true, chatUnlimited: false },
    { code: "developer", title: "Застройщик", audience: "Застройщики и девелоперы с портфелем объектов",
      price: 17990, yearlyMonthly: 14392, yearlyTotal: 172704, trialDays: 0,
      objects: -1, employees: -1, priceBook: -1, estimates: 150, pd: 75, chat: 1500,
      ocr: 1000, legal: 300, marketplace: -1, cameras: 8, storageGb: 100,
      aiReset: 8500, extraGbPrice: 50, customDev: true, chatUnlimited: true },
  ];

  var TARIFF_PLANS = TARIFF_MATRIX.map(function (plan) {
    return { code: plan.code, title: plan.title };
  });

  function tariffPlan(code) {
    var wanted = String(code || "").trim();
    return TARIFF_MATRIX.filter(function (plan) {
      return plan.code === wanted;
    })[0] || TARIFF_MATRIX[0];
  }

  function tariffTitle(code) {
    var found = TARIFF_PLANS.filter(function (plan) { return plan.code === code; })[0];
    return found ? found.title : (code || "Не задан");
  }

  function orgStatusPill(org) {
    if (org && org.is_blocked) return pill("Заблокирована", "bad");
    var until = Date.parse(String((org && org.access_until) || ""));
    if (Number.isFinite(until) && until < Date.now()) return pill("Доступ истёк", "warn");
    return pill("Активна", "ok");
  }

  function fmtDate(value) {
    var text = String(value || "");
    if (!text) return "—";
    return text.slice(0, 16).replace("T", " ");
  }

  function daysLeftFrom(value) {
    var ts = Date.parse(String(value || ""));
    if (!Number.isFinite(ts)) return 0;
    var diff = ts - Date.now();
    return diff <= 0 ? 0 : Math.floor(diff / 86400000);
  }

  function orgTariffBadge(org) {
    if (org && org.is_unlimited_override) return pill("Безлимит", "info");
    var days = daysLeftFrom(org && (org.plan_expires_at || org.access_until));
    if (!days) return pill("Только чтение", "bad");
    return pill("Осталось " + days + " дн.", days <= 3 ? "warn" : "ok");
  }

  /// V194.6.0 (ТЗ §5.2): панель ручного управления тарифом организации.
  function openOrgTariffModal(org) {
    if (!org) return;
    var planOptions = TARIFF_MATRIX.map(function (plan) {
      return '<option value="' + esc(plan.code) + '"' +
        ((org.plan_code || "trial") === plan.code ? " selected" : "") + ">" +
        esc(plan.title) + "</option>";
    }).join("");
    var until = String(org.plan_expires_at || org.access_until || "").slice(0, 10);
    var unlimited = !!org.is_unlimited_override;
    var extraGb = Math.max(0, Math.round(num(org.extra_storage_gb)));
    openModal("Тариф и доступы · " + (org.name || ("Организация " + org.id)),
      '<div class="form-row">' +
      '<label class="field"><span>Тариф</span><select id="ot-plan">' + planOptions + "</select></label>" +
      '<label class="field"><span>Период оплаты</span><select id="ot-period">' +
      '<option value="monthly"' + ((org.billing_period || "monthly") === "monthly" ? " selected" : "") + ">Помесячно</option>" +
      '<option value="yearly"' + (org.billing_period === "yearly" ? " selected" : "") + ">За год (−20 %)</option>" +
      "</select></label>" +
      '<label class="field"><span>Оплачено до</span>' +
      '<input type="date" id="ot-until" value="' + esc(until) + '" /></label>' +
      "</div>" +
      '<label class="flex mt-8" style="align-items:center;gap:8px;">' +
      '<input type="checkbox" id="ot-unlimited"' + (unlimited ? " checked" : "") + " />" +
      "<span><strong>Безлимит (для друзей / партнёров)</strong>" +
      '<div class="small muted">Снимает все ограничения лимитов и срока — можно включить даже на триале.</div></span></label>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>+ ГБ хранилища сверх тарифа</span>' +
      '<input type="number" min="0" step="1" id="ot-gb" value="' + extraGb + '" /></label>' +
      '<label class="field"><span>Заметка суперадмина (видит только владелец)</span>' +
      '<input type="text" id="ot-note" value="' + esc(org.admin_tariff_note || "") + '" /></label>' +
      "</div>" +
      '<div class="flex mt-8" style="flex-wrap:wrap;gap:6px;">' +
      '<button class="btn btn-outline btn-sm" data-ot-extend="10" type="button">+10 дн.</button>' +
      '<button class="btn btn-outline btn-sm" data-ot-extend="30" type="button">+30 дн.</button>' +
      '<button class="btn btn-outline btn-sm" data-ot-extend="365" type="button">+365 дн.</button>' +
      '<button class="btn btn-outline btn-sm" id="ot-reset" type="button">Обнулить ИИ за месяц</button>' +
      "</div>" +
      '<div class="warn-box mt-16">ИНН: ' + esc(org.inn || "—") + " · КПП: " + esc(org.kpp || "—") +
      " · ОГРН: " + esc(org.ogrn || "—") + " · Сейчас: " + esc(tariffTitle(org.plan_code)) +
      " · " + (unlimited ? "безлимит" : "осталось " + daysLeftFrom(org.plan_expires_at) + " дн.") + "</div>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ot-save" type="button">Сохранить</button></div>');

    async function apply(patch, successText) {
      var body = Object.assign({ p_org_id: num(org.id) }, patch);
      var res = await sb.rpc("superadmin_update_org_tariff", body);
      if (res.error) { toast("Не сохранено: " + res.error.message, 7000); return; }
      closeModal();
      toast(successText || "Тариф и доступы обновлены");
      renderRoute();
    }

    $all("[data-ot-extend]", $("#modal-body")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        apply({ p_extend_days: Math.round(num(btn.getAttribute("data-ot-extend"))) },
          "Срок продлён на " + btn.textContent.trim());
      });
    });
    var resetBtn = $("#ot-reset");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      apply({ p_reset_usage: true }, "Счётчики ИИ за месяц обнулены");
    });
    $("#ot-save").addEventListener("click", function () {
      var dateText = String($("#ot-until").value || "").trim();
      apply({
        p_plan_code: $("#ot-plan").value,
        p_billing_period: $("#ot-period").value,
        p_is_unlimited_override: !!$("#ot-unlimited").checked,
        p_plan_expires_at: dateText ? new Date(dateText + "T23:59:59Z").toISOString() : null,
        p_extra_storage_gb: Math.max(0, Math.round(num($("#ot-gb").value))),
        p_admin_note: String($("#ot-note").value || "").trim() || null,
      }, "Тариф обновлён: " + tariffTitle($("#ot-plan").value));
    });
  }

  async function toggleOrgBlock(org) {
    if (!org) return;
    var next = !org.is_blocked;
    var res = await sb.from("organizations").update({ is_blocked: next }).eq("id", org.id);
    if (res.error) { toast("Статус не изменён: " + res.error.message, 6000); return; }
    toast(next ? "Организация заблокирована" : "Организация разблокирована");
    renderRoute();
  }

  function openDeleteOrgModal(org) {
    if (!org) return;
    if (num(org.id) === num(state.orgId)) {
      toast("Свою организацию удалить нельзя", 6000);
      return;
    }
    openModal("Удалить организацию?",
      '<div class="warn-box">«' + esc(org.name || ("Организация " + org.id)) + "» (ИНН " +
      esc(org.inn || "—") + ") будет удалена вместе с проектами, сметами, чертежами и " +
      "приглашениями. Профили сотрудников останутся, но потеряют привязку к компании.</div>" +
      '<label class="field mt-16"><span>Введите название организации для подтверждения</span>' +
      '<input type="text" id="del-org-name" placeholder="' + esc(org.name || "") + '" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-danger" id="del-org-confirm" type="button">Удалить организацию</button></div>');
    $("#del-org-confirm").addEventListener("click", async function () {
      var typed = String($("#del-org-name").value || "").trim();
      if (typed !== String(org.name || "").trim()) {
        toast("Название не совпадает — удаление отменено", 6000);
        return;
      }
      // Каскадная отвязка профилей выполняется в БД (ON DELETE SET NULL),
      // здесь дополнительно чистим приглашения по коду.
      try { await sb.from("org_invites").delete().eq("org_id", org.id); } catch (e) {}
      var res = await sb.from("organizations").delete().eq("id", org.id);
      if (res.error) { toast("Не удалось удалить: " + res.error.message, 7000); return; }
      closeModal();
      toast("Организация удалена");
      renderRoute();
    });
  }

  async function resetUserWebSessions(profileId) {
    if (!profileId) return;
    var res = await sb.from("web_qr_sessions")
      .update({ status: "revoked", access_token: null, refresh_token: null })
      .eq("user_id", profileId)
      .in("status", ["pending", "confirmed"]);
    if (res.error) { toast("Сессии не сброшены: " + res.error.message, 6000); return; }
    toast("Веб-сессии пользователя завершены");
  }

  function accountTypeTitle(type) {
    switch (String(type || "")) {
      case "employee": return "Сотрудник";
      case "brigadier": return "Бригадир / мастер";
      case "company_owner": return "Компания";
      default: return type || "—";
    }
  }

  function adminUsersRows(profiles, orgs) {
    var byId = {};
    (orgs || []).forEach(function (org) { byId[String(org.id)] = org.name || ""; });
    if (!profiles.length) {
      return '<tr><td colspan="9" class="muted">Пользователей пока нет.</td></tr>';
    }
    return profiles.map(function (p) {
      var orgName = byId[String(p.organization_id)] ||
        (p.organization_id ? "Организация " + p.organization_id : "—");
      var email = String(p.email || "");
      var isOwner = email.toLowerCase() === "rom61rus@yandex.ru";
      var isSelf = String(p.id) === String(state.userId);
      // V194.5 (ТЗ §5.2): «Регистрация» — дата создания аккаунта,
      // «Последний визит» — реальная активность (last_seen_at → last_login_at).
      var registered = fmtDate(p.created_at);
      var lastVisit = fmtDate(p.last_seen_at || p.created_at || "");
      var deleteBtn = (isOwner || isSelf)
        ? '<span class="small muted">' + (isOwner ? "владелец" : "вы") + "</span>"
        : '<button class="btn btn-danger btn-sm" data-user-del="' + esc(p.id) +
          '" data-user-email="' + esc(email) + '" data-user-name="' +
          esc(p.full_name || "") + '" type="button">Удалить</button>';
      return "<tr><td><strong>" + esc(p.full_name || "Без ФИО") + "</strong></td>" +
        "<td>" + esc(email) + "</td>" +
        "<td>" + esc(accountTypeTitle(p.account_type)) + "</td>" +
        "<td>" + esc(orgName) + "</td>" +
        "<td>" + esc(roleTitle(p.role)) + "</td>" +
        '<td class="small">' + esc(registered) + "</td>" +
        '<td class="small">' + esc(lastVisit) + "</td>" +
        '<td><button class="btn btn-outline btn-sm" data-user-sessions="' + esc(p.id) +
        '" type="button">Сбросить веб-сессии</button></td>' +
        "<td>" + deleteBtn + "</td></tr>";
    }).join("");
  }

  function adminUsersRowsLegacy(profiles, orgs) {
    var byId = {};
    (orgs || []).forEach(function (org) { byId[String(org.id)] = org.name || ""; });
    if (!profiles.length) {
      return '<tr><td colspan="7" class="muted">Пользователей пока нет.</td></tr>';
    }
    return profiles.map(function (p) {
      var orgName = byId[String(p.organization_id)] ||
        (p.organization_id ? "Организация " + p.organization_id : "—");
      return "<tr><td><strong>" + esc(p.full_name || "Без ФИО") + "</strong></td>" +
        "<td>" + esc(p.email || "") + "</td>" +
        "<td>" + esc(accountTypeTitle(p.account_type)) + "</td>" +
        "<td>" + esc(orgName) + "</td>" +
        "<td>" + esc(roleTitle(p.role)) + "</td>" +
        '<td class="small">' + esc(fmtDate(p.last_seen_at || p.created_at)) + "</td>" +
        '<td><button class="btn btn-outline btn-sm" data-user-sessions="' + esc(p.id) +
        '" type="button">Сбросить веб-сессии</button></td></tr>';
    }).join("");
  }


  // ═══════════ V192.7: «Профиль организации / Реквизиты» и брендинг ═══════════
  async function signedBrandingUrl(path) {
    if (!path) return "";
    if (/^https?:/i.test(path)) return path;
    try {
      var res = await sb.storage.from("org_branding").createSignedUrl(path, 3600);
      return res.error ? "" : ((res.data && res.data.signedUrl) || "");
    } catch (e) {
      return "";
    }
  }

  function orgField(id, label, value, placeholder) {
    return '<label class="field"><span>' + esc(label) + "</span>" +
      '<input type="text" id="' + id + '" value="' + esc(value || "") + '" placeholder="' +
      esc(placeholder || "") + '" /></label>';
  }

  async function renderOrgProfile(root) {
    root.innerHTML = '<div class="muted">Загрузка реквизитов организации…</div>';
    if (!(await requireAuth(root))) return;
    if (!state.orgId) {
      // V194.5.5-C2 (ТЗ §3): Демо-режим вместо тупика «Организация не привязана».
      if (orgMissing()) {
        renderNoOrgMode(root, {
          title: "Реквизиты доступны только организации",
          text: "Аккаунт работает без организации: реквизиты, фирменный бланк и тариф доступны " +
            "компаниям. Введите код приглашения или создайте свою организацию.",
        });
      } else {
        root.innerHTML = '<div class="card"><h3>Организация не привязана</h3>' +
          '<p class="small muted">Аккаунт частного мастера/бригадира работает без организации — ' +
          "реквизиты и фирменный бланк доступны компаниям.</p></div>";
      }
      return;
    }
    var res = await sb.from("organizations").select("*").eq("id", state.orgId).maybeSingle();
    if (res.error || !res.data) {
      root.innerHTML = '<div class="warn-box">Не удалось прочитать организацию: ' +
        esc(res.error ? res.error.message : "нет данных") + "</div>";
      return;
    }
    var org = res.data;
    state.orgRow = org;
    var bank = org.bank_details || {};
    var logoUrl = await signedBrandingUrl(org.logo_url);
    var letterheadUrl = await signedBrandingUrl(org.letterhead_url);

    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Профиль организации</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Реквизиты, подписант и фирменный бланк для КП и отчётов.</p></div>' +
      orgStatusPill(org) + "</div>" +
      '<div class="card mt-16"><h3>Реквизиты</h3><div class="form-row mt-8">' +
      orgField("org-name", "Название", org.name, "ООО «СтройИнвест»") +
      orgField("org-inn", "ИНН", org.inn, "10 или 12 цифр") +
      orgField("org-kpp", "КПП", org.kpp, "9 цифр") +
      orgField("org-ogrn", "ОГРН", org.ogrn, "13 или 15 цифр") +
      orgField("org-address", "Юридический адрес", org.legal_address, "город, улица, дом") +
      orgField("org-director", "ФИО подписанта", org.director_name, "Иванов Иван Иванович") +
      "</div>" +
      '<h3 class="mt-16">Банковские реквизиты</h3><div class="form-row mt-8">' +
      orgField("org-bank-name", "Банк", bank.bank_name, "ПАО Сбербанк") +
      orgField("org-bank-account", "Расчётный счёт", bank.account, "20 цифр") +
      orgField("org-bank-bik", "БИК", bank.bik, "9 цифр") +
      orgField("org-bank-corr", "Корр. счёт", bank.corr_account, "20 цифр") +
      "</div>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="org-save" type="button">Сохранить реквизиты</button>' +
      '<span class="small muted">Тариф: ' + esc(tariffTitle(org.tariff_plan)) + " · доступ до " +
      esc(fmtDate(org.access_until)) + "</span></div></div>" +
      '<div class="card mt-16"><h3>Логотип и фирменный бланк</h3>' +
      '<p class="small muted">PNG/JPG для логотипа, PDF/DOCX для бланка (до 5 МБ). ' +
      "Подставляются в шапку КП и сводных отчётов.</p>" +
      '<div class="grid grid-2 mt-8"><div>' +
      '<div class="small muted">Логотип</div>' +
      (logoUrl ? '<div class="mt-8"><img src="' + esc(logoUrl) + '" alt="Логотип" style="max-height:72px;border-radius:8px;" /></div>'
        : '<div class="small muted mt-8">не загружен</div>') +
      '<label class="field mt-8"><span>Загрузить логотип</span><input type="file" id="org-logo-file" accept="image/png,image/jpeg" /></label>' +
      "</div><div>" +
      '<div class="small muted">Фирменный бланк</div>' +
      (letterheadUrl ? '<div class="mt-8"><a href="' + esc(letterheadUrl) + '" target="_blank" rel="noopener">Открыть бланк</a></div>'
        : '<div class="small muted mt-8">не загружен</div>') +
      '<label class="field mt-8"><span>Загрузить бланк</span><input type="file" id="org-letterhead-file" accept=".pdf,.docx,application/pdf" /></label>' +
      "</div></div></div>";

    $("#org-save").addEventListener("click", saveOrgRequisites);
    var logoInput = $("#org-logo-file");
    if (logoInput) logoInput.addEventListener("change", function () {
      uploadOrgBranding("logo", logoInput.files && logoInput.files[0]);
    });
    var letterInput = $("#org-letterhead-file");
    if (letterInput) letterInput.addEventListener("change", function () {
      uploadOrgBranding("letterhead", letterInput.files && letterInput.files[0]);
    });
  }


  async function saveOrgRequisites() {
    var patch = {
      name: String($("#org-name").value || "").trim() || state.orgName,
      inn: String($("#org-inn").value || "").replace(/\D+/g, "") || null,
      kpp: String($("#org-kpp").value || "").replace(/\D+/g, "") || null,
      ogrn: String($("#org-ogrn").value || "").replace(/\D+/g, "") || null,
      legal_address: String($("#org-address").value || "").trim() || null,
      director_name: String($("#org-director").value || "").trim() || null,
      bank_details: {
        bank_name: String($("#org-bank-name").value || "").trim(),
        account: String($("#org-bank-account").value || "").replace(/\D+/g, ""),
        bik: String($("#org-bank-bik").value || "").replace(/\D+/g, ""),
        corr_account: String($("#org-bank-corr").value || "").replace(/\D+/g, ""),
      },
    };
    var res = await sb.from("organizations").update(patch).eq("id", state.orgId);
    if (res.error) { toast("Реквизиты не сохранены: " + res.error.message, 7000); return; }
    state.orgName = patch.name;
    renderSessionBadge();
    toast("Реквизиты организации сохранены");
    renderRoute();
  }

  async function uploadOrgBranding(kind, file) {
    if (!file) return;
    if (!state.orgId) { toast("Брендинг доступен только организации"); return; }
    var ext = String(file.name.split(".").pop() || "png").toLowerCase();
    var path = state.orgId + "/" + kind + "_" + Date.now() + "." + ext;
    var up = await sb.storage.from("org_branding")
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (up.error) { toast("Файл не загружен: " + up.error.message, 7000); return; }
    var patch = {};
    patch[kind === "logo" ? "logo_url" : "letterhead_url"] = path;
    var upd = await sb.from("organizations").update(patch).eq("id", state.orgId);
    if (upd.error) { toast("Файл загружен, но профиль не обновлён: " + upd.error.message, 7000); return; }
    toast(kind === "logo" ? "Логотип обновлён" : "Фирменный бланк обновлён");
    renderRoute();
  }

  // ═════════════ V192.7: приглашения сотрудников по коду (без ИНН) ═════════════
  function orgInviteCodeJs() {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var code = "";
    for (var i = 0; i < 8; i++) {
      code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return code;
  }

  async function createOrgInvite() {
    if (!state.orgId) { toast("Приглашения доступны только организации"); return; }
    var expiresInput = $("#org-invite-expires");
    // V193.2: код всегда создаётся со стартовой ролью «Гость» (GUEST).
    var role = "GUEST";
    var code = orgInviteCodeJs();
    var dateText = expiresInput ? String(expiresInput.value || "").trim() : "";
    var expiresAt = dateText
      ? new Date(dateText + "T23:59:59Z").toISOString()
      : new Date(Date.now() + 14 * 86400 * 1000).toISOString();
    var res = await sb.from("org_invites").insert({
      org_id: state.orgId,
      code: code,
      role: role,
      created_by: state.userId,
      expires_at: expiresAt,
      // V193.10: по умолчанию код одноразовый и «сгорает» при активации.
      is_reusable: !!(document.getElementById("org-invite-reusable") || {}).checked,
    });
    if (res.error) { toast("Код не создан: " + res.error.message, 7000); return; }
    var link = "https://neyroplan.ru/#/join?code=" + code;
    var box = $("#org-invite-result");
    if (box) {
      box.innerHTML = '<strong>' + esc(code) + "</strong> · " + esc(roleTitle(role)) +
        ' · <a href="' + esc(link) + '" target="_blank" rel="noopener">ссылка для сотрудника</a>';
    }
    toast("Код приглашения создан: " + code, 6000);
  }

  async function copyOrgInvite(code) {
    try {
      await navigator.clipboard.writeText("https://neyroplan.ru/#/join?code=" + code);
      toast("Ссылка скопирована");
    } catch (e) {
      toast("Код: " + code, 6000);
    }
  }



  // ═════════ V192.7: трёхветочная регистрация с E-mail OTP и согласиями ═════════
  var REG_BRANCHES = [
    { code: "company_owner", title: "Компания (ООО / ИП)" },
    { code: "employee", title: "Сотрудник компании" },
    { code: "brigadier", title: "Частный мастер / Бригадир" },
  ];

  var SPECIALIZATIONS = [
    "Монолит и ж/б работы",
    "Кровля и фасады",
    "Отделка помещений",
    "Электрика и слаботочные сети",
    "Сантехника и отопление",
    "Вентиляция и кондиционирование",
    "Благоустройство и дороги",
    "Демонтаж и подготовка",
  ];

  function regState() {
    if (!state.reg) {
      state.reg = {
        account_type: "company_owner",
        email: "",
        invite_code: "",
        plan_code: "",
        otpSent: false,
        lookup: null,
        // V194.6.3: явный шаг окна регистрации «form» → «otp» → «password».
        // Раньше после verifyOtp ошибка «Задайте пароль…» уходила только в тост,
        // и пользователь оставался на экране без полей ввода пароля.
        step: "form",
        form: null,
        pending: null,
        otpVerified: false,
        otpTimer: null,
        otpLeft: 0,
        completed: false,
        // V194.6.3 (доп.): окно нельзя закрыть, пока не задан пароль.
        locked: false,
        // V194.6.3b: защита от двойной отправки кода (скрытый 429).
        sending: false,
        // V194.6.5: занятый ИНН — блокируем переход к Шагу 3.
        innTaken: "",
      };
    }
    return state.reg;
  }

  // ── V194.6.3: уведомления, «занятые» кнопки и таймер повторной отправки ──
  var REG_OTP_COOLDOWN = 60;
  var REG_PASSWORD_MIN = 6;
  // V194.6.3 (доп.): черновик регистрации живёт под ключом np_pending_reg.
  var REG_PENDING_KEY = "np_pending_reg";
  var REG_PENDING_LEGACY_KEY = "neuroplan.reg.pending";
  // V194.6.4: резервный канал, если шлюз ещё не знает send_otp или нет ключа Resend.
  var SEND_OTP_FALLBACK = ["unknown_action", "resend_not_configured",
    "edge_unavailable", "edge_not_configured", "empty_response",
    "resend_failed", "otp_generate_failed", "prepare_user_failed",
    "generate_link_unreachable", "resend_unreachable"];
  var REG_PENDING_TTL_MS = 12 * 3600 * 1000;
  // V194.6.5: занятый ИНН — текст совпадает со шлюзом registration-gateway.
  var REG_INN_TAKEN_TEXT = "Организация с таким ИНН уже зарегистрирована. Попросите " +
    "руководителя добавить вас в разделе „Организация“ или укажите другой ИНН.";
  // V194.7.1: идёт запись регистрации (complete_registration) — параллельный
  // ремонт «Команды» (ensure_my_employee) в этот момент запрещён, иначе люди
  // попадают в пустую организацию-черновик.
  var registrationInFlight = false;

  /// Блок уведомлений прямо в окне регистрации: error / info / ok.
  function regNotice(kind, text) {
    var node = $("#reg-notice");
    if (!node) return;
    if (!text) {
      node.className = "reg-notice hidden";
      node.innerHTML = "";
      return;
    }
    node.className = "reg-notice reg-notice--" + (kind || "info");
    node.innerHTML = esc(text);
  }

  function regStopOtpTimer() {
    var reg = regState();
    if (reg.otpTimer) {
      clearInterval(reg.otpTimer);
      reg.otpTimer = null;
    }
  }

  /// Обратный отсчёт повторной отправки кода: «Запросить новый код через N сек».
  function regStartOtpTimer(seconds) {
    var reg = regState();
    regStopOtpTimer();
    reg.otpLeft = Math.max(0, Math.round(num(seconds) || REG_OTP_COOLDOWN));
    regPaintResend();
    reg.otpTimer = setInterval(function () {
      var current = regState();
      current.otpLeft = Math.max(0, num(current.otpLeft) - 1);
      regPaintResend();
      if (current.otpLeft <= 0) regStopOtpTimer();
    }, 1000);
  }

  function regPaintResend() {
    var reg = regState();
    var btn = $("#reg-resend");
    if (!btn) return;
    var left = num(reg.otpLeft);
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = "Запросить новый код через " + Math.ceil(left) + " сек";
    } else {
      btn.disabled = false;
      btn.textContent = "Запросить новый код";
    }
  }

  /// Подсветка кнопки «Запросить новый код», когда код истёк или не принят.
  function regHighlightResend() {
    var btn = $("#reg-resend");
    if (!btn) return;
    btn.classList.add("is-attention");
    try { btn.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }

  function regIsRateLimited(error) {
    var status = num(error && (error.status || error.statusCode));
    var text = String((error && (error.code || "")) || "") + " " +
      String((error && error.message) || "");
    return status === 429 || /rate limit|too many|429/i.test(text);
  }

  function regSendOtpErrorText(error) {
    if (regIsRateLimited(error)) {
      return "Слишком частые запросы. Подождите 60 секунд и запросите код снова.";
    }
    var message = String((error && error.message) || error || "").trim();
    if (/invalid.*email|unable to validate email|email address .* invalid/i.test(message)) {
      return "Проверьте e-mail: сервер не принял адрес.";
    }
    if (/fetch|network|load failed|timeout/i.test(message)) {
      return "Нет связи с сервером. Проверьте интернет и повторите — данные формы сохранены.";
    }
    return message || "Код не отправлен. Попробуйте ещё раз через минуту.";
  }

  function regVerifyErrorText(error) {
    var message = String((error && error.message) || error || "").trim();
    var code = String((error && error.code) || "") + " " + message;
    if (/otp_expired|expired|invalid|has expired|недействит/i.test(code)) {
      return "Код истёк или уже использован. Запросите новый код.";
    }
    if (regIsRateLimited(error)) {
      return "Слишком частые запросы. Подождите 60 секунд и запросите код снова.";
    }
    if (/fetch|network|load failed|timeout/i.test(message)) {
      return "Нет связи с сервером. Проверьте интернет и повторите.";
    }
    return message || "Код не принят. Проверьте цифры из письма.";
  }

  /// Черновик регистрации: позволяет вернуться к шагу пароля после перезагрузки.
  /// V194.6.3 (доп.): ключ np_pending_reg, старый ключ читается для миграции.
  function regSavePending(form) {
    try {
      window.localStorage.setItem(REG_PENDING_KEY, JSON.stringify({
        form: form || {},
        email: String((form && form.email) || ""),
        saved_at: Date.now(),
      }));
    } catch (e) { /* приватный режим — продолжаем без восстановления */ }
  }

  function regReadPending() {
    var parsed = null;
    var usedLegacy = false;
    try {
      var raw = window.localStorage.getItem(REG_PENDING_KEY);
      if (!raw) {
        raw = window.localStorage.getItem(REG_PENDING_LEGACY_KEY);
        usedLegacy = !!raw;
      }
      if (!raw) return null;
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!parsed || !parsed.form || !parsed.form.email) return null;
    if (Date.now() - num(parsed.saved_at) > REG_PENDING_TTL_MS) {
      regClearPending();
      return null;
    }
    if (usedLegacy) regSavePending(parsed.form);
    return parsed.form;
  }

  function regClearPending() {
    try { window.localStorage.removeItem(REG_PENDING_KEY); } catch (e) {}
    try { window.localStorage.removeItem(REG_PENDING_LEGACY_KEY); } catch (e) {}
  }

  /// V194.6.3 (доп.): незавершённая регистрация по флагам user_metadata.
  /// Существующие пользователи (флагов нет) не затрагиваются.
  function isPendingRegistrationMeta(meta) {
    if (!meta || typeof meta !== "object") return false;
    return meta.pending_registration === true || meta.password_set === false;
  }

  /// Город без служебных префиксов («г. Москва» → «Москва»), с ручной правкой.
  function regCityClean(raw) {
    return String(raw == null ? "" : raw).trim()
      .replace(/^(?:г(?:ород)?\.?\s+)/i, "")
      .replace(/^(?:г\.\s*)/i, "")
      .trim();
  }

  async function invokeRegistration(body) {
    try {
      var res = await sb.functions.invoke(CFG.registrationFunction || "registration-gateway", { body: body });
      if (res.error) {
        var ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") {
          try { return await ctx.json(); } catch (e) {}
        }
        return { ok: false, error: res.error.message || "edge_unavailable" };
      }
      return res.data || { ok: false, error: "empty_response" };
    } catch (e) {
      var errCtx = e && e.context;
      if (errCtx && typeof errCtx.json === "function") {
        try { return await errCtx.json(); } catch (e2) {}
      }
      return { ok: false, error: (e && e.message) || "edge_unavailable" };
    }
  }

  function openRegistration(branch, inviteCode, planCode) {
    var reg = regState();
    reg.account_type = branch || "company_owner";
    reg.invite_code = String(inviteCode || reg.invite_code || "");
    reg.plan_code = String(planCode || reg.plan_code || "");
    reg.otpSent = false;
    openModal("Регистрация в НейроПлане", '<div id="reg-body"></div>', "reg");
    // V194.6.3 (доп.): незавершённая регистрация по user_metadata — сразу пароль.
    if (state.userId && state.pendingReg) {
      enforceRegistrationPasswordStep();
      return;
    }
    // V194.6.3: если OTP уже подтверждён, а пароль ещё не задан — сразу шаг пароля.
    var pending = regReadPending();
    if (state.userId && pending &&
        String(pending.email || "").trim().toLowerCase() ===
        String(state.userEmail || "").trim().toLowerCase()) {
      reg.form = pending;
      reg.pending = pending;
      reg.email = String(pending.email || state.userEmail || "");
      reg.account_type = pending.account_type || reg.account_type;
      reg.otpVerified = true;
      renderPasswordStep(reg.email);
      return;
    }
    renderRegistrationForm();
  }

  function regField(id, label, type, value, placeholder) {
    return '<label class="field"><span>' + esc(label) + "</span>" +
      '<input type="' + (type || "text") + '" id="' + id + '" value="' + esc(value || "") +
      '" placeholder="' + esc(placeholder || "") + '" /></label>';
  }

  function regConsentRow(id, text, checked) {
    return '<label class="consent-row">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + " />" +
      '<span class="small">' + text + "</span></label>";
  }

  function regFormValue(key, fallback) {
    var cached = (regState().form || {})[key];
    if (cached != null && String(cached) !== "") return String(cached);
    return fallback == null ? "" : String(fallback);
  }

  function renderRegistrationForm() {
    var reg = regState();
    var box = $("#reg-body");
    if (!box) return;
    var tabs = REG_BRANCHES.map(function (branch) {
      var active = branch.code === reg.account_type;
      return '<button class="btn ' + (active ? "btn-navy" : "btn-outline") + ' btn-sm" data-reg-branch="' +
        branch.code + '" type="button">' + esc(branch.title) + "</button>";
    }).join(" ");
    // V194.6.3: перед перерисовкой запоминаем введённое, чтобы смена ветки
    // аккаунта не стирала данные пользователя.
    if ($("#reg-email") || $("#reg-inn")) {
      reg.form = Object.assign({}, reg.form || {}, regReadForm());
    }
    reg.step = "form";
    var cached = reg.form || {};
    var cachedConsents = (cached && cached.consents) || {};
    var fields = "";
    if (reg.account_type === "company_owner") {
      fields =
        '<div class="reg-inn-row mt-8">' +
        regField("reg-inn", "ИНН организации", "text",
          regFormValue("inn", reg.lookup ? reg.lookup.inn : ""), "10 или 12 цифр") +
        '<button class="btn btn-outline reg-inn-check" id="reg-inn-check" type="button">Проверить ИНН</button>' +
        "</div>" +
        '<div class="small mt-8" id="reg-inn-status"></div>' +
        '<div class="reg-grid reg-grid--2 mt-8">' +
        regField("reg-org-name", "Название организации", "text",
          regFormValue("org_name", reg.lookup ? reg.lookup.name : ""), "ООО «СтройИнвест»") +
        regField("reg-director", "ФИО руководителя", "text",
          regFormValue("director_name", reg.lookup ? reg.lookup.director_name : ""), "Иванов Иван Иванович") +
        "</div>";
    } else if (reg.account_type === "employee") {
      fields =
        '<div class="reg-grid reg-grid--2 mt-8">' +
        regField("reg-invite", "Код приглашения от руководителя", "text",
          regFormValue("invite_code", reg.invite_code), "6–12 символов") +
        regField("reg-fullname", "ФИО", "text", regFormValue("full_name", ""), "Петров Пётр Петрович") +
        "</div>" +
        '<p class="small muted mt-8">Код выдаёт руководитель в разделе «Команда». ИНН не нужен.</p>';
    } else {
      var specOptions = SPECIALIZATIONS.map(function (item) {
        return "<option>" + esc(item) + "</option>";
      }).join("");
      fields =
        '<div class="reg-grid reg-grid--2 mt-8">' +
        regField("reg-fullname", "ФИО", "text", regFormValue("full_name", ""), "Сидоров Иван Петрович") +
        "<label class=\"field\"><span>Специализация</span><select id=\"reg-spec\">" +
        specOptions + "</select></label>" +
        "</div>" +
        '<div class="reg-grid reg-grid--2 mt-8">' +
        regField("reg-brigade", "Размер бригады", "number", regFormValue("brigade_size", "1"), "1") +
        "</div>";
    }
    var common =
      '<div class="reg-grid reg-grid--3 mt-8">' +
      regField("reg-email", "E-mail", "email", regFormValue("email", reg.email), "master@company.ru") +
      regField("reg-phone", "Телефон", "tel", regFormValue("phone", ""), "+7 900 000-00-00") +
      regField("reg-city", "Город", "text", regFormValue("city", ""), "Москва") +
      "</div>";
    var catalogConsent = reg.account_type === "brigadier"
      ? regConsentRow("reg-consent-catalog",
        "Даю согласие на публикацию моих контактов и специализации в каталоге подрядчиков " +
        "для заказчиков платформы (ст. 10.1 152-ФЗ).", cachedConsents.public_catalog_10_1)
      : "";
    var hasSession = reg.otpVerified === true && !!state.userId;
    box.innerHTML =
      (reg.plan_code
        ? '<div class="pricing-selected">Выбран тариф: <strong>' +
          esc(tariffTitle(reg.plan_code)) + "</strong> — платформа работает в режиме открытого " +
          "тестирования: регистрация бесплатная, онлайн-оплата будет подключена позднее.</div>"
        : "") +
      '<p class="small muted">Выберите тип аккаунта — от него зависит набор данных и демо-доступ.</p>' +
      '<div class="flex mt-8">' + tabs + "</div>" +
      fields + common +
      '<div class="mt-16 reg-consents">' +
      regConsentRow("reg-consent-terms",
        "Принимаю Условия использования и Политику конфиденциальности (обязательно).",
        cachedConsents.terms_privacy) +
      regConsentRow("reg-consent-pdn",
        "Даю согласие на обработку моих персональных данных (ФИО, телефон, e-mail) " +
        "в соответствии с 152-ФЗ (обязательно).", cachedConsents.pdn_processing) +
      catalogConsent +
      "</div>" +
      '<div id="reg-notice" class="reg-notice hidden" role="alert"></div>' +
      '<div class="reg-actions">' +
      '<button class="btn btn-navy reg-action" id="reg-send-otp" type="button">' +
      (hasSession ? "Далее: задать пароль" : "Получить код на e-mail") + "</button>" +
      "</div>" +
      '<p class="small muted mt-8 reg-sender-note">Код подтверждения приходит письмом с адреса ' +
      "<strong>noreply@neyroplan.ru</strong>.</p>";

    $all("[data-reg-branch]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var reg2 = regState();
        reg2.form = Object.assign({}, reg2.form || {}, regReadForm());
        reg2.account_type = btn.getAttribute("data-reg-branch");
        renderRegistrationForm();
      });
    });
    var checkBtn = $("#reg-inn-check");
    if (checkBtn) checkBtn.addEventListener("click", regLookupInn);
    var sendBtn = $("#reg-send-otp");
    if (sendBtn) sendBtn.addEventListener("click", regSendOtp);
    // V194.6.5: занятый ИНН остаётся подсвеченным после перерисовки формы.
    if (reg.account_type === "company_owner" && reg.lookup &&
        reg.lookup.already_registered === true &&
        String(regFormValue("inn", "")).replace(/\D+/g, "") ===
          String(reg.lookup.inn || "")) {
      regShowInnTaken(false);
    }
  }


  function regReadForm() {
    var reg = regState();
    var cache = reg.form || {};
    var cachedConsents = cache.consents || {};
    function val(id, key) {
      var node = $("#" + id);
      if (node) return String(node.value || "").trim();
      return String(cache[key] == null ? "" : cache[key]).trim();
    }
    function checked(id, key) {
      var node = $("#" + id);
      if (node) return !!node.checked;
      return !!cachedConsents[key];
    }
    return {
      account_type: reg.account_type,
      full_name: val("reg-fullname", "full_name"),
      email: val("reg-email", "email"),
      phone: val("reg-phone", "phone"),
      city: val("reg-city", "city"),
      inn: val("reg-inn", "inn").replace(/\D+/g, ""),
      org_name: val("reg-org-name", "org_name"),
      director_name: val("reg-director", "director_name"),
      invite_code: (val("reg-invite", "invite_code")).toUpperCase(),
      plan_code: reg.plan_code || "",
      specialization: val("reg-spec", "specialization"),
      brigade_size: Math.max(1, Math.round(num(val("reg-brigade", "brigade_size") || "1"))),
      consents: {
        terms_privacy: checked("reg-consent-terms", "terms_privacy"),
        pdn_processing: checked("reg-consent-pdn", "pdn_processing"),
        public_catalog_10_1: checked("reg-consent-catalog", "public_catalog_10_1"),
      },
      user_agent: String((window.navigator && window.navigator.userAgent) || "").slice(0, 300),
    };
  }

  async function regLookupInn() {
    var inn = String(($("#reg-inn") && $("#reg-inn").value) || "").replace(/\D+/g, "");
    var statusNode = $("#reg-inn-status");
    if (!inn) {
      regNotice("error", "Введите ИНН организации — 10 цифр (ЮЛ) или 12 цифр (ИП).");
      return;
    }
    if (statusNode) statusNode.innerHTML = '<span class="pill pill-info">Проверяем ИНН…</span>';
    var data = await invokeRegistration({ action: "lookup_inn", inn: inn });
    if (!data || data.ok !== true) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-bad">' +
          esc((data && (data.message || data.error)) || "ИНН не проверен") + "</span>";
      }
      return;
    }
    var reg = regState();
    reg.lookup = data;
    reg.innTaken = data.already_registered ? String(data.inn || inn) : "";
    var innNode = $("#reg-inn");
    if (innNode) innNode.classList.toggle("reg-input-warn", data.already_registered === true);
    // V194.5.5-C2.1: автозаполнение названия и ФИО руководителя по DaData.
    // Ручной ввод не затирается: поле перезаписывается, только если оно пустое
    // или содержит прошлое автозначение.
    var auto = reg.innAuto || (reg.innAuto = { name: "", director: "", city: "" });
    if (!auto.city) auto.city = "";
    var details = [];
    if (data.name) details.push(data.name);
    if (data.kpp) details.push("КПП " + data.kpp);
    if (data.ogrn) details.push("ОГРН " + data.ogrn);
    if (data.status) details.push(String(data.status));
    if (data.already_registered) {
      reg.innTaken = String(data.inn || inn);
      if (statusNode) {
        statusNode.innerHTML = '<div class="reg-inn-warning">' +
          esc(REG_INN_TAKEN_TEXT) + "</div>";
      }
    } else if (data.manual_fill) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-info">Контрольная сумма верна. ' +
          "DaData недоступна — заполните название и руководителя вручную</span>";
      }
    } else {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-ok">' +
          esc(details.join(" · ") || "Организация найдена") + "</span>";
      }
    }
    applyAutoField($("#reg-org-name"), data.name, auto.name);
    if (data.name) auto.name = String(data.name);
    applyAutoField($("#reg-director"), data.director_name, auto.director);
    if (data.director_name) auto.director = String(data.director_name);
    // V194.6.3: город из DaData подставляется в поле «Город» с ручной правкой.
    var cityFromInn = regCityClean(data.city);
    if (cityFromInn) {
      applyAutoField($("#reg-city"), cityFromInn, auto.city);
      auto.city = cityFromInn;
      if (details.indexOf(cityFromInn) < 0) details.push(cityFromInn);
      if (statusNode && !data.already_registered && !data.manual_fill) {
        statusNode.innerHTML = '<span class="pill pill-ok">' +
          esc(details.filter(Boolean).join(" · ") || "Организация найдена") + "</span>";
      }
    }
  }

  /// V194.6.5: проверка занятости ИНН до отправки кода — на Шаг 3 с занятым
  /// ИНН пользователь не попадает.
  async function regInnAlreadyRegistered(inn) {
    var reg = regState();
    var value = String(inn || "").replace(/\D+/g, "");
    if (!value) return false;
    if (reg.lookup && String(reg.lookup.inn || "") === value) {
      return reg.lookup.already_registered === true;
    }
    var data = await invokeRegistration({ action: "lookup_inn", inn: value });
    if (data && data.ok === true) {
      reg.lookup = data;
      reg.innTaken = data.already_registered ? value : "";
      return data.already_registered === true;
    }
    return false;
  }

  /// V194.6.5: понятное предупреждение рядом с полем ИНН (не тост).
  function regShowInnTaken(focus) {
    var statusNode = $("#reg-inn-status");
    if (statusNode) {
      statusNode.innerHTML = '<div class="reg-inn-warning">' +
        esc(REG_INN_TAKEN_TEXT) + "</div>";
    }
    var innNode = $("#reg-inn");
    if (innNode) {
      innNode.classList.add("reg-input-warn");
      if (focus) innNode.focus();
    }
  }

  /// Заполняет поле, если оно пустое или содержит прошлое автозначение.
  function applyAutoField(node, next, previous) {
    if (!node || !next) return;
    var current = String(node.value || "").trim();
    if (current && current !== String(previous || "")) return;
    node.value = String(next);
  }

  async function regSendOtp() {
    var reg = regState();
    // V194.6.3b: защита от двойного клика/Enter — иначе скрытый 429 rate limit.
    if (reg.sending === true) return;
    // V194.6.3: сессия уже есть (OTP подтверждён) — сразу к шагу пароля.
    if (reg.otpVerified === true) {
      var cachedForm = regReadForm();
      reg.form = cachedForm;
      reg.pending = cachedForm;
      renderPasswordStep(reg.email || cachedForm.email);
      return;
    }
    var form = regReadForm();
    reg.form = form;
    if (!form.consents.terms_privacy || !form.consents.pdn_processing) {
      regNotice("error",
        "Отметьте оба обязательных согласия: Условия/Политика и обработка персональных данных (152-ФЗ).");
      return;
    }
    if (!form.email || form.email.indexOf("@") < 0) {
      regNotice("error", "Укажите корректный e-mail — на него придёт код подтверждения.");
      return;
    }
    if (form.account_type === "company_owner" && form.inn.length !== 10 && form.inn.length !== 12) {
      regNotice("error", "ИНН организации — 10 цифр (ЮЛ) или 12 цифр (ИП).");
      return;
    }
    // V194.6.5: занятый ИНН отсекается на Шаге 1 — код не отправляется.
    if (form.account_type === "company_owner") {
      var innBusy = await regInnAlreadyRegistered(form.inn);
      if (innBusy) {
        regShowInnTaken(true);
        regNotice("error", REG_INN_TAKEN_TEXT);
        return;
      }
    }
    if (form.account_type === "employee" && form.invite_code.length < 6) {
      regNotice("error", "Код приглашения — не короче 6 символов.");
      return;
    }
    var btn = $("#reg-send-otp");
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем код..."; }
    regNotice("info", "Отправляем код подтверждения на " + form.email + "…");
    // V194.6.3 (доп.): реквизиты регистрации сохраняем ДО сетевого вызова —
    // в user_metadata (чтобы триггер не создал заглушку «Компания …») и в
    // localStorage np_pending_reg (на случай перезагрузки страницы).
    var pendingForm = {
      account_type: form.account_type,
      email: String(form.email).trim(),
      full_name: form.full_name,
      phone: form.phone,
      city: form.city,
      inn: form.inn,
      org_name: form.org_name,
      company_name: form.org_name,
      director_name: form.director_name,
      invite_code: form.invite_code,
      specialization: form.specialization,
      brigade_size: form.brigade_size,
      plan_code: form.plan_code,
      consents: form.consents,
      user_agent: form.user_agent,
    };
    regSavePending(pendingForm);
    var otpData = {
      pending_registration: true,
      password_set: false,
      company_name: pendingForm.company_name || "",
      inn: pendingForm.inn || "",
      director_name: pendingForm.director_name || "",
      full_name: pendingForm.full_name || pendingForm.director_name || "",
      phone: pendingForm.phone || "",
      city: pendingForm.city || "",
      account_type: pendingForm.account_type || "company_owner",
    };
    reg.sending = true;
    if (btn) btn.disabled = true;
    // V194.6.4: ОДИН запрос к шлюзу — он сам генерирует 6-значный код
    // (admin generate_link, type=magiclink) и отправляет письмо напрямую
    // через Resend. Лимит писем Supabase Auth (60 секунд) не участвует.
    var failure = "";
    var viaFallback = false;
    try {
      var sent = await invokeRegistration({
        action: "send_otp",
        email: pendingForm.email,
        full_name: otpData.full_name,
        data: otpData,
      });
      if (!(sent && sent.ok === true && sent.sent === true)) {
        var sentCode = String((sent && sent.error) || "");
        if (SEND_OTP_FALLBACK.indexOf(sentCode) >= 0) {
          // Резервный канал (шлюз ещё не задеплоен или нет ключа Resend):
          // прежняя схема prepare_email + signInWithOtp.
          viaFallback = true;
          var prepared = await invokeRegistration({
            action: "prepare_email",
            email: pendingForm.email,
            data: otpData,
          });
          var res = await sb.auth.signInWithOtp({
            email: pendingForm.email,
            options: {
              shouldCreateUser: !(prepared && prepared.ok === true),
              data: otpData,
            },
          });
          if (res.error) failure = regSendOtpErrorText(res.error);
        } else if (sentCode === "invalid_email") {
          failure = "Укажите корректный e-mail — на него придёт код подтверждения.";
        } else {
          failure = String((sent && (sent.message || sent.error)) ||
            "Код не отправлен. Повторите через минуту.");
        }
      }
    } catch (e) {
      failure = "Нет связи с сервером. Проверьте интернет и повторите — данные формы сохранены.";
    } finally {
      reg.sending = false;
      if (btn) btn.disabled = false;
    }
    if (failure) {
      if (btn) btn.textContent = "Получить код на e-mail";
      regNotice("error", failure);
      return;
    }
    reg.email = pendingForm.email;
    reg.pending = pendingForm;
    reg.otpSent = true;
    regSavePending(pendingForm);
    renderOtpStep(reg.email);
    regStartOtpTimer(REG_OTP_COOLDOWN);
    regNotice("ok", "Код отправлен на " + reg.email +
      (viaFallback ? " (резервный канал). " : ". ") +
      "Письмо приходит с адреса noreply@neyroplan.ru — проверьте папку «Спам», если его не видно.");
  }

  function renderOtpStep(email) {
    var box = $("#reg-body");
    if (!box) return;
    var reg = regState();
    reg.step = "otp";
    box.innerHTML =
      '<div class="reg-step-head"><span class="reg-step-badge">Шаг 2 из 3</span>' +
      "<h4>Подтвердите e-mail</h4>" +
      '<p class="small muted">Код отправлен на <strong>' + esc(email) + "</strong>. " +
      "Введите 6 цифр из письма — письмо приходит с адреса " +
      "<strong>noreply@neyroplan.ru</strong>.</p></div>" +
      '<div id="reg-notice" class="reg-notice hidden" role="alert"></div>' +
      '<label class="field mt-8"><span>Код из письма</span>' +
      '<input type="text" id="reg-otp" inputmode="numeric" maxlength="6" placeholder="000000" ' +
      'autocomplete="one-time-code" /></label>' +
      '<div class="reg-actions">' +
      '<button class="btn btn-navy reg-action" id="reg-verify" type="button">Подтвердить код</button>' +
      '<button class="btn btn-outline reg-action-secondary" id="reg-resend" type="button">' +
      "Запросить новый код</button>" +
      '<button class="btn btn-outline reg-action-secondary" id="reg-back" type="button">' +
      "Изменить данные</button>" +
      "</div>";
    $("#reg-verify").addEventListener("click", regVerifyOtp);
    $("#reg-resend").addEventListener("click", function () {
      regNotice("info", "Запрашиваем новый код…");
      regSendOtp();
    });
    $("#reg-back").addEventListener("click", renderRegistrationForm);
    var otpInput = $("#reg-otp");
    if (otpInput) {
      otpInput.addEventListener("keydown", function (event) {
        if (event && event.key === "Enter") regVerifyOtp();
      });
    }
    regPaintResend();
  }

  async function regVerifyOtp() {
    var reg = regState();
    var code = String(($("#reg-otp") && $("#reg-otp").value) || "").trim();
    var email = String(reg.email || "").trim();
    if (!email) {
      regNotice("error", "Не найден e-mail регистрации — начните оформление заново.");
      return;
    }
    if (!/^[0-9]{6}$/.test(code)) {
      regNotice("error", "Код — ровно 6 цифр из письма.");
      return;
    }
    var btn = $("#reg-verify");
    if (btn) { btn.disabled = true; btn.textContent = "Проверяем..."; }
    regNotice("info", "Проверяем код…");
    var verify = await sb.auth.verifyOtp({ email: email, token: code, type: "magiclink" });
    if (verify.error) {
      // Фоллбэк: токен из admin generate_link принимается и типом «email»
      // (в части версий GoTrue magiclink/email — синонимы).
      var fallback = await sb.auth.verifyOtp({ email: email, token: code, type: "email" });
      if (!fallback.error) verify = fallback;
      else verify = { error: verify.error };
    }
    if (verify.error) {
      if (btn) { btn.disabled = false; btn.textContent = "Подтвердить код"; }
      regNotice("error", regVerifyErrorText(verify.error));
      regHighlightResend();
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = "Подтвердить код"; }
    regStopOtpTimer();
    reg.otpVerified = true;
    reg.email = email;
    var form = reg.pending || regReadForm();
    form.email = email;
    reg.form = form;
    reg.pending = form;
    regSavePending(form);
    // V194.6.3 (критический фикс): после успешного verifyOtp всегда открывается
    // шаг «Задайте пароль для аккаунта» — без него регистрация не завершается.
    renderPasswordStep(email);
    regNotice("ok", "Почта подтверждена. Остался последний шаг — придумайте пароль.");
  }

  // ── V194.6.3: явный шаг «Задайте пароль для аккаунта» ──
  function renderPasswordStep(email) {
    var box = $("#reg-body");
    if (!box) return;
    var reg = regState();
    reg.step = "password";
    var mail = String(email || reg.email || state.userEmail || "").trim();
    if (mail) reg.email = mail;
    box.innerHTML =
      '<div class="reg-step-head"><span class="reg-step-badge">Шаг 3 из 3</span>' +
      "<h4>Задайте пароль для аккаунта</h4>" +
      '<p class="small muted">Почта <strong>' + esc(mail) + "</strong> подтверждена. " +
      "Пароль нужен для входа с компьютера и со смартфона — запишите его.</p></div>" +
      '<div id="reg-notice" class="reg-notice hidden" role="alert"></div>' +
      '<label class="field"><span>Придумайте пароль</span>' +
      '<div class="reg-pwd-row">' +
      '<input type="password" id="reg-password" autocomplete="new-password" ' +
      'placeholder="Минимум 6 символов" />' +
      '<button class="btn btn-outline btn-sm reg-pwd-toggle" id="reg-password-eye" ' +
      'type="button">Показать</button></div></label>' +
      '<label class="field"><span>Повторите пароль</span>' +
      '<div class="reg-pwd-row">' +
      '<input type="password" id="reg-password2" autocomplete="new-password" ' +
      'placeholder="Повторите пароль" />' +
      '<button class="btn btn-outline btn-sm reg-pwd-toggle" id="reg-password2-eye" ' +
      'type="button">Показать</button></div></label>' +
      '<p class="small muted" id="reg-password-hint">Проверка перед сохранением: ' +
      "не короче 6 символов и оба поля совпадают.</p>" +
      '<div class="reg-actions">' +
      '<button class="btn btn-navy reg-action" id="reg-save-password" type="button">' +
      "Сохранить пароль и завершить регистрацию</button>" +
      (reg.locked
        ? '<button class="btn btn-outline reg-action-secondary" id="reg-logout" type="button">' +
          "Выйти</button>"
        : '<button class="btn btn-outline reg-action-secondary" id="reg-edit-form" type="button">' +
          "Изменить данные</button>") +
      "</div>";
    regBindPasswordEye("reg-password-eye", "reg-password");
    regBindPasswordEye("reg-password2-eye", "reg-password2");
    var saveBtn = $("#reg-save-password");
    if (saveBtn) saveBtn.addEventListener("click", regSavePassword);
    var logoutBtn = $("#reg-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", regLogoutLocked);
    var editBtn = $("#reg-edit-form");
    if (editBtn) editBtn.addEventListener("click", function () {
      reg.form = Object.assign({}, reg.form || {}, regReadForm());
      renderRegistrationForm();
    });
    var second = $("#reg-password2");
    if (second) {
      second.addEventListener("keydown", function (event) {
        if (event && event.key === "Enter") regSavePassword();
      });
    }
  }

  function regBindPasswordEye(btnId, inputId) {
    var btn = $("#" + btnId);
    var input = $("#" + inputId);
    if (!btn || !input) return;
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Скрыть" : "Показать";
    });
  }

  /// Дозапись ФИО/телефона/города в профиль, если значения ещё не сохранены.
  async function regPatchProfile(form) {
    if (!state.userId) return false;
    var patch = {};
    var fullName = String((form && form.full_name) || "").trim();
    var phone = String((form && form.phone) || "").trim();
    var city = String((form && form.city) || "").trim();
    if (fullName) patch.full_name = fullName;
    if (phone) patch.phone = phone;
    if (city) patch.city = city;
    if (!Object.keys(patch).length) return true;
    try {
      var res = await sb.from("profiles").update(patch).eq("id", state.userId);
      if (res.error) {
        console.warn("[reg] профиль не обновлён:", res.error.message);
        return false;
      }
      // V194.6.3b: ФИО/телефон/город сразу попадают в шапку без перезагрузки.
      if (Object.keys(patch).length) {
        state.profile = Object.assign({}, state.profile || {}, patch);
        renderSessionBadge();
      }
      return true;
    } catch (e) {
      console.warn("[reg] профиль не обновлён:", e);
      return false;
    }
  }

  // ── V194.6.3: сохранение пароля и завершение регистрации ──
  async function regSavePassword() {
    var reg = regState();
    var pwdNode = $("#reg-password");
    var pwd2Node = $("#reg-password2");
    var pwd = String((pwdNode && pwdNode.value) || "");
    var pwd2 = String((pwd2Node && pwd2Node.value) || "");
    if (pwd.length < REG_PASSWORD_MIN) {
      regNotice("error", "Пароль должен быть не короче " + REG_PASSWORD_MIN + " символов.");
      if (pwdNode) pwdNode.focus();
      return;
    }
    if (pwd !== pwd2) {
      regNotice("error", "Пароли не совпадают — проверьте оба поля.");
      if (pwd2Node) pwd2Node.focus();
      return;
    }
    var btn = $("#reg-save-password");
    var idleLabel = "Сохранить пароль и завершить регистрацию";
    if (btn) { btn.disabled = true; btn.textContent = "Сохраняем..."; }
    regNotice("info", "Сохраняем пароль и записываем данные организации…");

    var form = Object.assign({}, reg.pending || reg.form || {}, regReadForm());
    form.email = String(form.email || reg.email || "").trim();
    form.password = pwd;
    // Реквизиты из проверки ИНН нужны для перезаписи организации.
    if (reg.lookup) {
      if (!form.inn && reg.lookup.inn) form.inn = String(reg.lookup.inn);
      if (!form.org_name && reg.lookup.name) form.org_name = String(reg.lookup.name);
      if (!form.director_name && reg.lookup.director_name) {
        form.director_name = String(reg.lookup.director_name);
      }
      if (reg.lookup.kpp) form.kpp = String(reg.lookup.kpp);
      if (reg.lookup.ogrn) form.ogrn = String(reg.lookup.ogrn);
      if (reg.lookup.address) form.legal_address = String(reg.lookup.address);
    }

    // 1) Пароль + снятие флага «регистрация не завершена» в user_metadata.
    var saved = await sb.auth.updateUser({
      password: pwd,
      data: {
        pending_registration: false,
        password_set: true,
        registration_completed: true,
        registration_completed_at: new Date().toISOString(),
        account_type: form.account_type || reg.account_type || "company_owner",
        company_name: form.org_name || form.company_name || "",
        inn: form.inn || "",
        director_name: form.director_name || "",
        full_name: form.full_name || form.director_name || "",
        phone: form.phone || "",
        city: form.city || "",
      },
    });
    if (saved.error) {
      if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
      regNotice("error", "Пароль не сохранён: " +
        String(saved.error.message || "ошибка Supabase") + ". Поля не очищены — повторите попытку.");
      return;
    }
    reg.locked = false;
    state.pendingReg = false;

    // 2) Организация/профиль/согласия — идемпотентно, если ещё не записаны.
    // V194.7.1: пока идёт запись, ensure_my_employee («Команда») не запускается —
    // гонка двух запросов создавала людей в пустой организации-черновике.
    registrationInFlight = true;
    var dbNote = "";
    if (reg.completed !== true) {
      var data = await invokeRegistration(Object.assign({ action: "complete_registration" }, form));
      if (data && data.ok === true) {
        reg.completed = true;
      } else {
        var errCode = String((data && data.error) || "");
        // V194.6.5: занятый ИНН больше не «проглатывается» — если организация
        // этому аккаунту не принадлежит, показываем понятную причину.
        if (errCode === "inn_already_registered") {
          if (num(state.orgId)) {
            reg.completed = true;
          } else {
            dbNote = String((data && data.message) || REG_INN_TAKEN_TEXT);
          }
        } else if (errCode === "invite_used" || errCode === "invite_expired") {
          // Инвайт уже учтён — данные в БД есть, регистрация не ломается.
          reg.completed = true;
        } else {
          dbNote = String((data && (data.message || data.error)) ||
            "данные организации не записаны");
        }
      }
    }
    // 3) UPDATE (а не только INSERT): перезаписываем автосозданную заглушку
    // «Компания …» реальным названием, ИНН, руководителем, телефоном, городом.
    var updateNote = await regApplyRegistrationData(form);
    // V194.7.1: организация и профиль записаны — ремонт «Команды» снова разрешён.
    registrationInFlight = false;
    if (updateNote && !dbNote) dbNote = updateNote;
    // V194.6.3b: ФИО в шапке обновляем сразу после записи профиля.
    var headerName = String(form.full_name || form.director_name || "").trim();
    if (headerName) {
      state.profile = Object.assign({}, state.profile || {}, { full_name: headerName });
      renderSessionBadge();
    }

    if (dbNote) {
      if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
      // Черновик остаётся: после перезагрузки шаг пароля снова откроется.
      regSavePending(form);
      regNotice("error", "Пароль сохранён, но данные не записаны: " + dbNote +
        ". Проверьте поля (кнопка «Изменить данные») и нажмите кнопку ещё раз.");
      return;
    }

    regClearPending();
    regStopOtpTimer();
    reg.completed = false;
    reg.otpVerified = false;
    reg.pending = null;
    await loadProfile();
    renderSessionBadge();
    closeModal(true);
    toast("Пароль сохранён — регистрация завершена. Добро пожаловать в кабинет!", 7000);
    location.hash = "#/cabinet";
    renderRoute();
  }

  /// V194.6.3 (доп.): перезапись реквизитов в уже созданных строках БД.
  /// Возвращает текст ошибки или пустую строку.
  async function regApplyRegistrationData(form) {
    var note = "";
    await regPatchProfile(form);
    // V194.6.3b: ФИО из формы сразу становится именем в шапке.
    var displayName = String((form && (form.full_name || form.director_name)) || "").trim();
    if (displayName) {
      state.profile = Object.assign({}, state.profile || {}, { full_name: displayName });
      renderSessionBadge();
    }
    // Организация могла появиться только что — перечитываем профиль.
    try { await loadProfile(); } catch (e) { /* не блокирует сохранение */ }
    var orgId = num(state.orgId);
    if (!orgId) return note;
    var name = String((form && (form.org_name || form.company_name)) || "").trim();
    var inn = String((form && form.inn) || "").replace(/\D+/g, "");
    var kpp = String((form && form.kpp) || "").replace(/\D+/g, "");
    var ogrn = String((form && form.ogrn) || "").replace(/\D+/g, "");
    var director = String((form && (form.director_name || form.full_name)) || "").trim();
    var address = String((form && form.legal_address) || "").trim();
    // Если название не заполнено, но ИНН известен — берём реквизиты из DaData,
    // чтобы вместо заглушки «Компания …» в БД оказалось реальное имя.
    if ((!name || !director) && inn) {
      var lookup = await invokeRegistration({ action: "lookup_inn", inn: inn });
      if (lookup && lookup.ok === true) {
        if (!name && lookup.name) name = String(lookup.name).trim();
        if (!director && lookup.director_name) {
          director = String(lookup.director_name).trim();
        }
        if (!kpp && lookup.kpp) kpp = String(lookup.kpp).replace(/\D+/g, "");
        if (!ogrn && lookup.ogrn) ogrn = String(lookup.ogrn).replace(/\D+/g, "");
        if (!address && lookup.address) address = String(lookup.address).trim();
      }
    }
    var patch = {};
    if (name) patch.name = name;
    if (inn) patch.inn = inn;
    if (kpp) patch.kpp = kpp;
    if (ogrn) patch.ogrn = ogrn;
    if (director) patch.director_name = director;
    if (address) patch.legal_address = address;
    if (!Object.keys(patch).length) return note;
    try {
      var res = await sb.from("organizations").update(patch).eq("id", orgId);
      if (res.error) {
        console.warn("[reg] организация не обновлена:", res.error.message);
        note = "реквизиты организации не перезаписаны: " + res.error.message;
      } else if (patch.name) {
        state.orgName = patch.name;
      }
    } catch (e) {
      console.warn("[reg] организация не обновлена:", e);
      note = "реквизиты организации не перезаписаны";
    }
    return note;
  }

  /// V194.6.3 (доп.): выход из аккаунта при незавершённой регистрации.
  async function regLogoutLocked() {
    var reg = regState();
    reg.locked = false;
    await dropGhostSession("Вы вышли из аккаунта. Данные черновика удалены — зарегистрируйтесь заново.", true);
  }

  /// V194.6.3 (доп.): живой пользователь на сервере — защита от «призрачной» сессии.
  async function verifyLiveSession() {
    var session = null;
    try {
      session = (await sb.auth.getSession()).data.session;
    } catch (e) {
      session = null;
    }
    if (!session) return null;
    var result = null;
    try {
      result = await sb.auth.getUser();
    } catch (e) {
      result = { error: e };
    }
    var user = result && result.data ? result.data.user : null;
    var error = result && result.error;
    if (!error && user) {
      // V194.6.3b: ФИО из user_metadata доступно шапке сразу после входа.
      state.userMeta = user.user_metadata || {};
      return user;
    }
    var status = num(error && (error.status || error.statusCode));
    var text = (String((error && error.code) || "") + " " +
      String((error && error.message) || "")).toLowerCase();
    var dead = !user || status === 401 || status === 403 ||
      /user_not_found|session_not_found|invalid|expired|jwt|not found|не найден/.test(text);
    if (dead) {
      await dropGhostSession("Сессия завершена — войдите заново", true);
    }
    return null;
  }

  /// Полная очистка локального следа пользователя и гостевая шапка.
  async function dropGhostSession(message, removeDraft) {
    try { await sb.auth.signOut({ scope: "local" }); } catch (e) { /* токена могло не быть */ }
    stopSessionWatch();
    clearWebSession();
    clearAdminVerified();
    closeAdminVerifyTimers();
    state.profile = null;
    state.userId = null;
    state.userEmail = "";
    state.orgId = 0;
    state.orgName = "";
    state.isSuper = false;
    state.pendingReg = false;
    state.userMeta = {};
    state.legalV2 = null;
    state.projects = [];
    state.projectsError = "";
    state.activeProjectId = 0;
    try { localStorage.removeItem("np_active_project"); } catch (e) {}
    if (removeDraft !== false) regClearPending();
    if (state.reg) {
      regStopOtpTimer();
      state.reg.locked = false;
    }
    state.reg = null;
    closeModal(true);
    renderSessionBadge();
    var hash = String(location.hash || "");
    if (hash.indexOf("#/cabinet") === 0 || hash.indexOf("#/admin") === 0) {
      location.hash = "#/";
    } else {
      renderRoute();
    }
    if (message) toast(message, 7000);
  }

  /// V194.6.3 (доп.): пока пароль не задан, в кабинет не пускаем.
  async function enforceRegistrationPasswordStep(userArg) {
    if (!state.userId) return false;
    var user = userArg || null;
    if (!user || !user.user_metadata) {
      try { user = (await sb.auth.getUser()).data.user; } catch (e) { user = null; }
    }
    if (!user) return false;
    var meta = user.user_metadata || {};
    if (!isPendingRegistrationMeta(meta)) {
      state.pendingReg = false;
      return false;
    }
    state.pendingReg = true;
    if ($("#reg-password")) {
      regState().locked = true;
      return true;
    }
    var local = regReadPending() || {};
    var reg = regState();
    reg.account_type = local.account_type || meta.account_type || "company_owner";
    reg.email = String(user.email || local.email || state.userEmail || "").trim();
    reg.form = {
      account_type: reg.account_type,
      email: reg.email,
      full_name: local.full_name || meta.full_name || "",
      phone: local.phone || meta.phone || "",
      city: local.city || meta.city || "",
      inn: local.inn || meta.inn || "",
      org_name: local.org_name || local.company_name || meta.company_name || "",
      director_name: local.director_name || meta.director_name || "",
      invite_code: local.invite_code || meta.invite_code || "",
      specialization: local.specialization || meta.specialization || "",
      brigade_size: local.brigade_size || 1,
      plan_code: local.plan_code || "",
      consents: local.consents ||
        { terms_privacy: true, pdn_processing: true, public_catalog_10_1: false },
      user_agent: String((window.navigator && window.navigator.userAgent) || "").slice(0, 300),
    };
    reg.pending = reg.form;
    reg.otpVerified = true;
    reg.locked = true;
    openModal("Регистрация в НейроПлане", '<div id="reg-body"></div>', "reg");
    renderPasswordStep(reg.email);
    regNotice("error",
      "Регистрация не завершена: придумайте пароль — кабинет откроется сразу после сохранения.");
    return true;
  }

  /// V194.6.3: возврат к шагу пароля после перезагрузки страницы.
  async function maybeResumeRegistration(userArg) {
    if (!state.userId) return false;
    if ($("#reg-password")) return true;
    var gated = await enforceRegistrationPasswordStep(userArg);
    if (gated) return true;
    var pending = regReadPending();
    if (!pending) return false;
    var email = String(pending.email || "").trim().toLowerCase();
    if (!email || email !== String(state.userEmail || "").trim().toLowerCase()) return false;
    var user = userArg || null;
    if (!user || !user.user_metadata) {
      try {
        user = (await sb.auth.getUser()).data.user;
      } catch (e) {
        user = null;
      }
    }
    var meta = (user && user.user_metadata) || {};
    if (meta.password_set === true || meta.registration_completed === true) {
      regClearPending();
      return false;
    }
    var reg = regState();
    reg.account_type = pending.account_type || reg.account_type;
    reg.email = String(pending.email || state.userEmail || "");
    reg.form = pending;
    reg.pending = pending;
    reg.otpVerified = true;
    openModal("Регистрация в НейроПлане", '<div id="reg-body"></div>', "reg");
    renderPasswordStep(reg.email);
    regNotice("info", "Регистрация не завершена — задайте пароль для аккаунта.");
    return true;
  }

  // V192.9: каналы связи — Звонок, WhatsApp, Telegram, MAX (копирование номера).
  function phoneDigits(phone) {
    return String(phone || "").replace(/\D+/g, "");
  }

  function whatsappUrl(phone) {
    var digits = phoneDigits(phone);
    if (!digits) return "";
    if (digits.charAt(0) === "8") digits = "7" + digits.slice(1);
    return "https://wa.me/" + digits;
  }

  function telegramUrl(phone) {
    var digits = phoneDigits(phone);
    if (!digits) return "";
    if (digits.charAt(0) === "8") digits = "7" + digits.slice(1);
    return "https://t.me/+" + digits;
  }

  async function openMaxMessenger(phone) {
    var digits = phoneDigits(phone);
    if (!digits) { toast("Телефон не указан"); return; }
    if (digits.charAt(0) === "8") digits = "7" + digits.slice(1);
    try {
      await navigator.clipboard.writeText("+" + digits);
      toast("Номер +" + digits + " скопирован — вставьте его в MAX", 6000);
    } catch (e) {
      toast("MAX: номер +" + digits, 6000);
    }
    window.open("https://max.ru/", "_blank");
  }

  function contactButtonsHtml(phone) {
    var digits = String(phone || "").trim();
    if (!digits) return "";
    var wa = whatsappUrl(digits);
    var tg = telegramUrl(digits);
    var html = '<a class="btn btn-outline btn-sm" href="tel:' + esc(digits) + '">Позвонить</a>';
    if (wa) html += '<a class="btn btn-outline btn-sm" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>';
    if (tg) html += '<a class="btn btn-outline btn-sm" href="' + esc(tg) + '" target="_blank" rel="noopener">Telegram</a>';
    html += '<button class="btn btn-outline btn-sm" data-max-phone="' + esc(digits) + '" type="button">MAX</button>';
    return html;
  }

  function bindMaxButtons(root) {
    $all("[data-max-phone]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openMaxMessenger(btn.getAttribute("data-max-phone"));
      });
    });
  }

  // ═════════════ V192.8 (Спринт 3): «Подрядчики и Биржа» ═════════════
  var CONTRACTOR_SPECIALIZATIONS = [
    "Монолит и ж/б работы", "Кровля и фасады", "Отделка помещений",
    "Электрика и слаботочные сети", "Сантехника и отопление",
    "Вентиляция и кондиционирование", "Благоустройство и дороги",
    "Демонтаж и подготовка",
  ];

  // V194.5.5-B: Биржа — отдельный раздел шапки, табы «Моя база / Биржа» удалены.

  function starsText(rating) {
    var value = Math.max(1, Math.min(5, Math.round(num(rating) || 5)));
    var filled = "";
    var empty = "";
    for (var i = 0; i < value; i++) filled += "★";
    for (var j = value; j < 5; j++) empty += "☆";
    return '<span style="color:#F59E0B;">' + filled + '</span><span class="muted">' + empty + "</span>";
  }

function contractorRowsHtml(rows, filters) {
    var q = String((filters || {}).q || "");
    var city = String((filters || {}).city || "");
    var list = (rows || []).filter(function (row) {
      if (city && String(row.city || "") !== city) return false;
      if (!q) return true;
      var haystack = [row.full_name, row.specialization, row.city, row.notes].join(" ").toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
    if (!list.length) {
      return '<tr><td colspan="7" class="muted">Пока никого нет — добавьте первого подрядчика.</td></tr>';
    }
    return list.map(function (row) {
      return "<tr><td><strong>" + esc(row.full_name) + "</strong>" +
        '<div class="flex mt-8">' + contactButtonsHtml(row.phone) + "</div></td>" +
        "<td>" + esc(row.specialization) + "</td>" +
        "<td>" + esc(row.city || "—") + "</td>" +
        '<td class="num">' + (num(row.brigade_size) || 1) + "</td>" +
        "<td>" + starsText(row.rating) + "</td>" +
        '<td class="small">' + esc(row.notes || "") + "</td>" +
        '<td><div class="flex">' +
        '<button class="btn btn-outline btn-sm" data-contractor-edit="' + esc(row.id) + '" type="button">Изменить</button>' +
        '<button class="btn btn-danger btn-sm" data-contractor-del="' + esc(row.id) + '" type="button">Удалить</button>' +
        "</div></td></tr>";
    }).join("");
  }


  function bindContractorRows(root) {
    function pick(attr) {
      return (state.orgContractors || []).filter(function (row) {
        return String(row.id) === attr;
      })[0];
    }
    $all("[data-contractor-edit]", root).forEach(function (btn) {
      btn.addEventListener("click", function () { openContractorModal(pick(btn.getAttribute("data-contractor-edit"))); });
    });
    $all("[data-contractor-del]", root).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var row = pick(btn.getAttribute("data-contractor-del"));
        if (!row) return;
        var del = await sb.from("org_contractors").delete().eq("id", row.id);
        if (del.error) { toast("Не удалось удалить: " + del.error.message, 6000); return; }
        toast("Подрядчик удалён");
        renderRoute();
      });
    });
  }

  // ═════════ V194.5.6-B (ТЗ §2): вкладки «Подрядчики» / «Договоры» ═════════
  function contractsTabsHtml(active) {
    var isContracts = active === "contracts";
    return '<div class="flex mt-16" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn ' + (isContracts ? "btn-outline" : "btn-navy") +
      '" id="ct-tab-contractors" type="button">Подрядчики</button>' +
      '<button class="btn ' + (isContracts ? "btn-navy" : "btn-outline") +
      '" id="ct-tab-contracts" type="button">Договоры</button></div>';
  }

  function bindContractsTabs() {
    var contractors = $("#ct-tab-contractors");
    if (contractors) {
      contractors.addEventListener("click", function () {
        state.contractsTab = "contractors";
        renderRoute();
      });
    }
    var contracts = $("#ct-tab-contracts");
    if (contracts) {
      contracts.addEventListener("click", function () {
        state.contractsTab = "contracts";
        renderRoute();
      });
    }
  }

  /// Реестр договоров организации + форма создания и скачивание `.docx`.
  async function renderContracts(root) {
    root.innerHTML = '<div class="muted">Загрузка договоров…</div>';
    if (!(await requireAuth(root))) return;
    var res = await sb.from("org_contracts").select("*")
      .eq("organization_id", state.orgId)
      .order("created_at", { ascending: false }).limit(500);
    if (res.error) {
      renderFailure(root, "Реестр договоров не загрузился", res.error.message,
        function () { renderContracts(root); });
      return;
    }
    var rows = res.data || [];
    // V194.5.6-D (ТЗ §3): список подрядчиков для выбора контрагента в договоре.
    if (!state.orgContractors || !state.orgContractors.length) {
      try {
        var ctRes = await sb.from("org_contractors").select("*")
          .eq("org_id", state.orgId).order("full_name").limit(500);
        state.orgContractors = (ctRes && ctRes.data) || [];
      } catch (e) { /* ручной ввод остаётся доступен */ }
    }
    root.innerHTML =
      '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Подрядчики и Договоры</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Реестр договоров организации: ' +
      "стороны, суммы, предпросмотр документа и скачивание .docx.</p></div>" +
      '<button class="btn btn-navy" id="contract-add" type="button">+ Создать договор</button></div>' +
      contractsTabsHtml("contracts") +
      // V194.7.0 (ТЗ §2): ИИ-юрист 2.0 — файл договора, галочки правок,
      // подтверждение реквизитов и готовый .docx одним потоком.
      '<div class="card mt-16 legal-v2">' +
      '<div class="flex-between" style="gap:10px;flex-wrap:wrap;">' +
      '<div><strong>ИИ-юрист 2.0 — проверка и правка договора</strong>' +
      '<div class="small muted">Загрузите .docx, .pdf или скан (.jpg/.png): найдём риски ' +
      "по штрафам, срокам и условиям, дадим галочки на исправления и соберём чистый " +
      '.docx с вашими реквизитами · <span id="legal-quota">проверяем лимит…</span></div></div>' +
      '<button class="btn btn-outline btn-sm" id="legal-review-btn" type="button">' +
      "Проверить по реестру</button>" +
      "</div>" +
      '<div class="legal-drop" id="legal-drop" role="button" tabindex="0" ' +
      'aria-label="Загрузить договор для проверки">' +
      '<input type="file" id="legal-file" class="hidden" ' +
      'accept=".docx,.pdf,.jpg,.jpeg,.png" />' +
      '<div class="legal-drop-icon" aria-hidden="true">📄</div>' +
      '<div class="legal-drop-title">Перетащите договор сюда или нажмите, чтобы выбрать файл</div>' +
      '<div class="small muted">DOCX · PDF · сканы JPG/PNG · до 25 МБ</div>' +
      '<div class="small legal-file-note" id="legal-file-name"></div>' +
      "</div></div>" +
      '<div class="card mt-16"><div class="table-wrap" style="max-height:58vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>№</th><th>Дата</th><th>Контрагент</th>' +
      '<th>Предмет</th><th class="num">Сумма</th><th>Шаблон</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(contractRowHtml).join("")
        : '<tr><td colspan="7" class="muted">Договоров пока нет — создайте первый.</td></tr>') +
      "</tbody></table></div></div>";
    bindContractsTabs();
    var addBtn = $("#contract-add");
    if (addBtn) addBtn.addEventListener("click", openContractModal);
    loadLegalQuotaLabel();
    bindLegalV2();
    var legalBtn = $("#legal-review-btn");
    if (legalBtn) legalBtn.addEventListener("click", function () {
      openLegalReviewModal(rows);
    });
    $all("[data-contract-ai]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openLegalReviewModal(rows, btn.getAttribute("data-contract-ai"));
      });
    });
    $all("[data-contract-preview]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        previewContract(btn.getAttribute("data-contract-preview"));
      });
    });
    $all("[data-contract-download]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        downloadContract(btn.getAttribute("data-contract-download"));
      });
    });
    $all("[data-contract-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteContract(btn.getAttribute("data-contract-del"));
      });
    });
  }

  function contractRowHtml(row) {
    var template = contractTemplateTitle(row.template);
    // V194.5.6-E (ТЗ §4): в реестре видно, кто мы по договору и кто контрагент.
    var role = String(row.role || "customer");
    var counterparty = role === "customer"
      ? (row.contractor_name || row.customer_name || "—")
      : (row.customer_name || row.contractor_name || "—");
    var rolePill = pill(role === "customer" ? "Мы — Заказчик" : "Мы — Подрядчик",
      role === "customer" ? "info" : "ok");
    return "<tr><td><strong>" + esc(row.number || "б/н") + "</strong><div>" +
      rolePill + "</div></td>" +
      '<td class="small">' + esc(String(row.contract_date || "").slice(0, 10)) + "</td>" +
      "<td>" + esc(counterparty) + "</td>" +
      '<td class="small">' + esc(row.subject || "—") + "</td>" +
      '<td class="num">' + money(row.amount) + "</td>" +
      '<td class="small">' + esc(template) + "</td>" +
      '<td><div class="flex" style="gap:6px;flex-wrap:wrap;">' +
      // V194.5.6-D (ТЗ §3): качественный предпросмотр перед скачиванием.
      '<button class="btn btn-outline btn-sm" data-contract-preview="' + esc(row.id) +
      '" type="button">Просмотр</button>' +
      '<button class="btn btn-navy btn-sm" data-contract-download="' + esc(row.id) +
      '" type="button">Скачать</button>' +
      '<button class="btn btn-outline btn-sm" data-contract-ai="' + esc(row.id) +
      '" type="button">ИИ-юрист</button>' +
      '<button class="btn btn-outline btn-sm" data-contract-del="' + esc(row.id) +
      '" type="button">Удалить</button></div></td></tr>';
  }

  /// V194.5.6-D (ТЗ §3): предпросмотр договора в стиле документа.

  /// V194.6.0 (ТЗ §3): остаток проверок договоров в текущем месяце.
  async function loadLegalQuotaLabel() {
    var node = $("#legal-quota");
    if (!node || !num(state.orgId)) return;
    var res = await sb.rpc("get_org_subscription_summary",
      { p_org_id: num(state.orgId) });
    if (res.error || !res.data) { node.textContent = "лимит недоступен"; return; }
    var limit = num((res.data.limits || {}).legal_checks_limit);
    var used = num((res.data.usage || {}).legal_checks_used);
    node.textContent = limit < 0
      ? "безлимит"
      : "осталось " + Math.max(0, limit - used) + " из " + limit;
  }

  function openLegalReviewModal(rows, preselectId) {
    var list = rows || [];
    var options = list.map(function (row) {
      return '<option value="' + esc(row.id) + '">№ ' + esc(row.number || "б/н") +
        " · " + esc(row.customer_name || row.contractor_name || "контрагент не указан") +
        "</option>";
    }).join("");
    openModal("Проверить договор (ИИ-юрист)",
      (list.length
        ? '<label class="field"><span>Договор из реестра</span>' +
          '<select id="lr-contract">' + options + "</select></label>"
        : '<p class="small muted">Договоров в реестре нет — вставьте текст договора.</p>') +
      '<label class="field mt-8"><span>Текст договора (необязательно)</span>' +
      '<textarea id="lr-text" rows="5" placeholder="Вставьте текст договора — проверим именно его"></textarea></label>' +
      '<p class="small muted mt-8">Проверяем: опечатки и даты, роли сторон и реквизиты, ' +
      "суммы прописью и цифрами, юридические риски (неустойки, сроки оплаты, приёмка, " +
      "гарантия) с готовыми формулировками исправлений.</p>" +
      '<div class="small" id="lr-status" style="min-height:18px;color:#B91C1C;"></div>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="lr-run" type="button">' +
      "Проверить договор (ИИ-юрист)</button></div>");
    if (preselectId) {
      var sel = $("#lr-contract");
      if (sel) sel.value = String(preselectId);
    }
    $("#lr-run").addEventListener("click", function () { runLegalReview(list); });
  }

  ///
  /// Показывает все реквизиты, которые попадут в `.docx` (стороны, предмет,
  /// объект, сумма, НДС, шаблон) — до скачивания видно, что подставится.
  async function previewContract(contractId) {
    var id = num(contractId);
    if (!id) return;
    var res = await sb.from("org_contracts").select("*").eq("id", id)
      .eq("organization_id", state.orgId).maybeSingle();
    var data = res && res.data && !res.error ? res.data : null;
    if (!data) { toast("Договор не найден", 6000); return; }
    await renderContractDocument(data, id);
  }

  async function runLegalReview(rows) {
    var status = $("#lr-status");
    var button = $("#lr-run");
    var sel = $("#lr-contract");
    var id = sel ? sel.value : "";
    var text = String(($("#lr-text") || {}).value || "").trim();
    var row = (rows || []).filter(function (item) {
      return String(item.id) === String(id);
    })[0] || null;
    if (!row && !text) {
      if (status) status.textContent = "Выберите договор или вставьте текст";
      return;
    }
    var base = String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
    if (!base) { if (status) status.textContent = "Воркер не настроен"; return; }
    if (button) { button.disabled = true; button.textContent = "Проверяем…"; }
    if (status) status.textContent = "";
    try {
      var session = (await sb.auth.getSession()).data.session;
      if (!session) throw new Error("Сессия истекла — войдите заново");
      if (!state.orgRow) {
        var orgRes = await sb.from("organizations").select("*")
          .eq("id", state.orgId).maybeSingle();
        state.orgRow = orgRes.data || null;
      }
      var payload = {
        contract: row ? {
          number: row.number, date: row.contract_date, subject: row.subject,
          amount: row.amount, vat_rate: row.vat_rate, role: row.role,
          items: row.items || [], customer_name: row.customer_name,
          customer_inn: row.customer_inn, contractor_name: row.contractor_name,
          contractor_inn: row.contractor_inn, object_name: row.object_name,
          object_address: row.object_address,
        } : {},
        organization: state.orgRow || {},
        text: text,
      };
      var resp = await fetch(base + "/api/contracts/ai-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.accessToken,
        },
        body: JSON.stringify(payload),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data || data.ok !== true) {
        var reason = (data && data.details && data.details.reason) || "";
        var message = (data && (data.error || data.detail)) || ("HTTP " + resp.status);
        if (reason === "expired" || reason === "limit_reached") {
          closeModal();
          openQuotaModal(message, reason);
        } else if (status) {
          status.textContent = message;
        }
        return;
      }
      closeModal();
      showLegalReport(data);
      loadLegalQuotaLabel();
    } catch (e) {
      if (status) status.textContent = "Не проверено: " + ((e && e.message) || e);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Проверить договор (ИИ-юрист)";
      }
    }
  }

  function notifyLegalQuota(message, reason) {
    openModal(reason === "expired" ? "Подписка истекла" : "Лимит ИИ-юриста",
      '<div class="warn-box">' + esc(message) + "</div>" +
      '<p class="small muted mt-8">Тариф можно продлить или сменить в Профиле → ' +
      "«Мой тариф и лимиты».</p>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="lq-close" type="button">' +
      "Понятно</button></div>");
    var btn = $("#lq-close");
    if (btn) btn.addEventListener("click", closeModal);
  }

  function openQuotaModal(message, reason) {
    notifyLegalQuota(message, reason);
  }

  function showLegalReport(data) {
    var issues = Array.isArray(data.issues) ? data.issues : [];
    var tone = data.risk_level === "high" ? "#DC2626"
      : (data.risk_level === "medium" ? "#B45309" : "#047857");
    var labels = {
      typos: "Опечатки", dates: "Даты", punctuation: "Запятые и пробелы",
      cases: "Падежи", roles: "Роли сторон", requisites: "Реквизиты",
      amounts: "Суммы", legal: "Юридические риски"
    };
    var body = issues.length
      ? issues.map(function (issue) {
        var color = issue.severity === "high" ? "#DC2626"
          : (issue.severity === "medium" ? "#B45309" : "#475569");
        return '<div class="card" style="padding:10px;margin-bottom:6px;border-color:#E2E8F0;">' +
          '<div class="small" style="color:' + color + ';font-weight:800;">' +
          esc(labels[issue.category] || issue.category || "Замечание") +
          (issue.clause ? " · п. " + esc(issue.clause) : "") + "</div>" +
          '<div class="small mt-8">' + esc(issue.found || "") + "</div>" +
          (issue.fix ? '<div class="small mt-8" style="color:#0F766E;">Как исправить: ' +
            esc(issue.fix) + "</div>" : "") + "</div>";
      }).join("")
      : '<p class="small muted">Замечаний не найдено.</p>';
    var quota = data.quota || {};
    openModal("Отчёт ИИ-юриста",
      '<div class="flex-between"><strong>Риск: ' + esc(data.risk_level || "—") +
      "</strong>" + pill("замечаний: " + issues.length + " · критичных: " +
        num((data.counts || {}).high), "warn") + "</div>" +
      (data.summary ? '<p class="small mt-8">' + esc(data.summary) + "</p>" : "") +
      (data.ai_available === false
        ? '<div class="warn-box mt-8">ИИ-модель недоступна (' + esc(data.ai_error || "") +
          ") — показаны локальные проверки дат, запятых, реквизитов и сумм.</div>"
        : "") +
      '<div class="mt-8" style="max-height:46vh;overflow:auto;">' + body + "</div>" +
      '<div class="small muted mt-8">Остаток проверок: ' +
      (num(quota.limit) < 0 ? "безлимит"
        : num(quota.remaining) + " из " + num(quota.limit)) + "</div>" +
      '<div class="flex mt-16"><button class="btn btn-outline" id="lr-close" type="button">' +
      "Закрыть</button></div>");
    var closeBtn = $("#lr-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
  }


  // ═════════════ V194.7.0 (ТЗ §2): ИИ-юрист 2.0 на веб-портале ═════════════
  // Файл (.docx/.pdf/скан) → Supabase Storage `contract_documents` → анализ
  // DeepSeek → галочки правок → подтверждение реквизитов → готовый .docx.
  var LEGAL_V2_MAX_MB = 25;
  var LEGAL_V2_BUCKET = "contract_documents";
  var LEGAL_V2_MIME = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
  };

  function legalV2State() {
    if (!state.legalV2) {
      state.legalV2 = { file: null, document: null, data: null, selected: [], busy: false };
    }
    return state.legalV2;
  }

  function legalEngineBase() {
    return String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
  }

  function legalFileExt(name) {
    return String(name || "").split(".").pop().toLowerCase();
  }

  function legalFileBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || "");
        resolve(raw.indexOf(",") >= 0 ? raw.split(",")[1] : raw);
      };
      reader.onerror = function () { reject(new Error("файл не прочитан")); };
      reader.readAsDataURL(file);
    });
  }

  function bindLegalV2() {
    var drop = $("#legal-drop");
    var input = $("#legal-file");
    if (!drop || !input) return;
    drop.addEventListener("click", function (event) {
      if (event.target === input) return;
      input.click();
    });
    drop.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    ["dragenter", "dragover"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add("is-over");
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.remove("is-over");
      });
    });
    drop.addEventListener("drop", function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) runLegalV2Review(files[0]);
    });
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (file) runLegalV2Review(file);
      input.value = "";
    });
  }

  /// Исходник договора — в приватный бакет организации (папка = org id).
  async function uploadContractSource(file) {
    try {
      var ext = legalFileExt(file.name);
      var orgId = num(state.orgId);
      var key = (orgId ? String(orgId) : "shared") + "/contracts/sources/" +
        "contract_" + Date.now() + "." + ext;
      var up = await sb.storage.from(LEGAL_V2_BUCKET).upload(key, file, {
        contentType: LEGAL_V2_MIME[ext] || file.type || "application/octet-stream",
        upsert: false,
      });
      if (up.error) {
        console.warn("[legal] источник не загружен в Storage:", up.error.message);
        return null;
      }
      return { bucket: LEGAL_V2_BUCKET, path: key,
        name: String(file.name || "contract." + ext), mime: LEGAL_V2_MIME[ext] || "" };
    } catch (e) {
      console.warn("[legal] Storage недоступен:", (e && e.message) || e);
      return null;
    }
  }

  /// Анализ загруженного файла: Storage (или base64-фолбэк) → /api/contracts/ai-review.
  async function runLegalV2Review(file) {
    var st = legalV2State();
    if (st.busy) return;
    var name = String(file.name || "");
    var ext = legalFileExt(name);
    if (!LEGAL_V2_MIME[ext]) {
      toast("Поддерживаются .docx, .pdf и сканы .jpg/.png", 7000);
      return;
    }
    if (file.size > LEGAL_V2_MAX_MB * 1024 * 1024) {
      toast("Файл больше " + LEGAL_V2_MAX_MB + " МБ — уменьшите документ", 7000);
      return;
    }
    var base = legalEngineBase();
    if (!base) { toast("Воркер проверки договоров не настроен", 7000); return; }
    var note = $("#legal-file-name");
    st.file = file;
    st.busy = true;
    if (note) note.textContent = "Проверяем «" + name + "»…";
    try {
      var session = (await sb.auth.getSession()).data.session;
      if (!session) throw new Error("Сессия истекла — войдите заново");
      var payload = { file_name: name, mime: LEGAL_V2_MIME[ext] };
      var uploaded = await uploadContractSource(file);
      st.document = uploaded || null;
      if (uploaded) payload.document = uploaded;
      else payload.file_base64 = await legalFileBase64(file);
      var resp = await fetch(base + "/api/contracts/ai-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: CFG.supabaseAnonKey,
        },
        body: JSON.stringify(payload),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data || data.ok !== true) {
        var reason = (data && data.details && data.details.reason) || "";
        var message = (data && (data.error || data.detail || data.message)) || ("HTTP " + resp.status);
        if (reason === "expired" || reason === "limit_reached") {
          openQuotaModal(message, reason);
        } else {
          toast("Проверка не выполнена: " + message, 9000);
        }
        return;
      }
      st.data = data;
      st.selected = [];
      st.document = data.document || uploaded || null;
      if (note) note.textContent = "Файл проверен: «" + name + "»";
      loadLegalQuotaLabel();
      openLegalStepA(data);
    } catch (e) {
      toast("Проверка не выполнена: " + ((e && e.message) || e), 9000);
      if (note) note.textContent = "";
    } finally {
      st.busy = false;
    }
  }

  var LEGAL_ISSUE_LABELS = {
    typos: "Опечатки", dates: "Даты", punctuation: "Запятые и пробелы",
    cases: "Падежи", roles: "Роли сторон", requisites: "Реквизиты",
    amounts: "Суммы", legal: "Юридические риски",
  };

  function legalWarningsText(warnings) {
    var map = {
      pdf_without_text_layer: "PDF без текстового слоя — текст распознан локальным OCR, проверьте точность.",
      scan_not_recognized: "Скан не распознан: загрузите более чёткое фото или текстовый PDF/DOCX.",
      empty_text: "В документе не найден текст — проверьте файл.",
      text_required: "Текст не извлечён — загрузите другой файл.",
      storage_upload_failed: "Не удалось сохранить файл в облако — используется резервная передача.",
    };
    return (warnings || []).map(function (item) { return map[item] || item; }).join(" ");
  }

  /// Карточка замечания с галочкой «Внести исправление?».
  function legalIssueCardHtml(issue, index) {
    var auto = issue && issue.auto_apply === true;
    var severity = String((issue && issue.severity) || "low");
    var color = severity === "high" ? "#DC2626" : (severity === "medium" ? "#B45309" : "#475569");
    var label = LEGAL_ISSUE_LABELS[issue && issue.category] || (issue && issue.category) || "Замечание";
    return '<label class="legal-issue' + (auto ? " is-auto" : "") + '">' +
      '<input type="checkbox" data-legal-issue="' + index + '"' +
      (auto ? " checked" : "") + " />" +
      '<span class="legal-issue-body">' +
      '<span class="legal-issue-head" style="color:' + color + ';">' +
      esc(label) + (issue && issue.clause ? " · п. " + esc(issue.clause) : "") +
      (auto ? ' <span class="legal-auto-pill">внесём автоматически</span>'
        : ' <span class="legal-manual-pill">вручную</span>') + "</span>" +
      '<span class="small">' + esc((issue && issue.found) || "") + "</span>" +
      (issue && issue.fix ? '<span class="small legal-issue-fix">Как исправить: ' +
        esc(issue.fix) + "</span>" : "") +
      "</span></label>";
  }

  /// Шаг А: список найденных проблем/рисков с галочками «Внести исправления?».
  function openLegalStepA(data) {
    var issues = Array.isArray(data.issues) ? data.issues : [];
    var counts = data.counts || {};
    var st = legalV2State();
    var docName = (data.document && data.document.name) ||
      (st.file && st.file.name) || "договор";
    var warnings = legalWarningsText(data.warnings);
    var cards = issues.length
      ? issues.map(legalIssueCardHtml).join("")
      : '<p class="small muted">Замечаний не найдено — переходите к подтверждению реквизитов.</p>';
    openModal("ИИ-юрист 2.0 · шаг 1 из 2",
      '<div class="legal-doc-line">Документ: <strong>' + esc(docName) + "</strong>" +
      (data.ocr_used ? ' <span class="pill pill-warn">скан распознан</span>' : "") +
      (data.document && data.document.kind ? ' <span class="pill pill-info">' +
        esc(String(data.document.kind).toUpperCase()) + "</span>" : "") + "</div>" +
      '<div class="flex-between mt-8" style="gap:8px;flex-wrap:wrap;">' +
      "<strong>Риск: " + esc(data.risk_level || "—") + "</strong>" +
      '<span class="small muted">Замечаний: ' + issues.length +
      " · критичных: " + num(counts.high) + "</span></div>" +
      (data.summary ? '<p class="small mt-8">' + esc(data.summary) + "</p>" : "") +
      (warnings ? '<div class="warn-box mt-8 small">' + esc(warnings) + "</div>" : "") +
      '<div class="legal-issues-label mt-8">Внести исправления?</div>' +
      '<div class="legal-issues">' + cards + "</div>" +
      '<div class="flex mt-8" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-outline btn-sm" id="legal-check-all" type="button">' +
      "Выбрать все авто-правки</button>" +
      '<button class="btn btn-outline btn-sm" id="legal-uncheck-all" type="button">Снять все</button></div>' +
      '<p class="small muted mt-8">Галочка = исправление попадёт в документ. Замечания с ' +
      "пометкой «вручную» попадут в лист «Замечания ИИ-юриста» для ручной правки.</p>" +
      '<div class="flex mt-16" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-navy" id="legal-step-a-next" type="button">Далее: реквизиты →</button>' +
      '<button class="btn btn-outline" id="legal-step-a-close" type="button">Закрыть</button></div>');
    $all("[data-legal-issue]").forEach(function (node) {
      if (node.disabled) return;
      var card = node.closest(".legal-issue");
      if (card) card.classList.toggle("is-checked", node.checked);
      node.addEventListener("change", function () {
        if (card) card.classList.toggle("is-checked", node.checked);
      });
    });
    var checkAll = $("#legal-check-all");
    if (checkAll) checkAll.addEventListener("click", function () { legalToggleAll(true); });
    var uncheckAll = $("#legal-uncheck-all");
    if (uncheckAll) uncheckAll.addEventListener("click", function () { legalToggleAll(false); });
    var next = $("#legal-step-a-next");
    if (next) next.addEventListener("click", function () {
      openLegalStepB(legalSelectedIssues());
    });
    var close = $("#legal-step-a-close");
    if (close) close.addEventListener("click", closeModal);
  }

  function legalToggleAll(checked) {
    $all("[data-legal-issue]").forEach(function (node) {
      if (node.disabled) return;
      node.checked = checked;
      var card = node.closest(".legal-issue");
      if (card) card.classList.toggle("is-checked", checked);
    });
  }

  function legalSelectedIssues() {
    var st = legalV2State();
    var issues = (st.data && st.data.issues) || [];
    var selected = [];
    $all("[data-legal-issue]").forEach(function (node) {
      if (node.disabled || !node.checked) return;
      var index = Number(node.getAttribute("data-legal-issue"));
      var issue = issues[index];
      if (issue) selected.push(issue);
    });
    return selected;
  }


  function legalFieldHtml(id, label, value, placeholder) {
    return '<label class="field"><span>' + esc(label) + "</span>" +
      '<input type="text" id="' + id + '" value="' + esc(value || "") +
      '" placeholder="' + esc(placeholder || "") + '" /></label>';
  }

  /// Подсказка с официальными реквизитами из DaData (если ключ настроен).
  function legalDadataHint(data) {
    var info = (data && data.dadata) || {};
    var parts = [];
    ["customer", "contractor"].forEach(function (side) {
      var item = info[side] || {};
      if (!item.name) return;
      parts.push((side === "customer" ? "Заказчик" : "Подрядчик") + ": " +
        item.name + (item.inn ? " (ИНН " + item.inn + ")" : ""));
    });
    return parts.join(" · ");
  }

  /// Шаг Б: подтверждение/корректировка реквизитов, сумм и сроков.
  function openLegalStepB(selected) {
    var st = legalV2State();
    st.selected = selected || [];
    var f = (st.data && st.data.fields) || {};
    var autoCount = 0;
    var manualCount = 0;
    st.selected.forEach(function (item) {
      if (item && item.auto_apply === true) autoCount += 1;
      else manualCount += 1;
    });
    openModal("ИИ-юрист 2.0 · шаг 2 из 2",
      '<p class="small muted">Подтвердите или поправьте реквизиты сторон, сумму и сроки — ' +
      "они попадут в исправленный договор. Авто-правок: <strong>" + autoCount +
      "</strong> · замечаний в лист ручной правки: <strong>" + manualCount + "</strong>.</p>" +
      '<div class="legal-fields mt-8">' +
      legalFieldHtml("legal-f-customer", "Заказчик", f.customer_name, "ООО «Ромашка»") +
      legalFieldHtml("legal-f-customer-inn", "ИНН заказчика", f.customer_inn, "10 или 12 цифр") +
      legalFieldHtml("legal-f-contractor", "Подрядчик", f.contractor_name, "ООО «Строй»") +
      legalFieldHtml("legal-f-contractor-inn", "ИНН подрядчика", f.contractor_inn, "10 или 12 цифр") +
      legalFieldHtml("legal-f-amount", "Цена договора, ₽", f.amount, "1 250 000,00") +
      legalFieldHtml("legal-f-date", "Дата договора", f.contract_date, "15.03.2026") +
      legalFieldHtml("legal-f-start", "Начало работ", f.start_date, "01.04.2026") +
      legalFieldHtml("legal-f-end", "Окончание работ", f.end_date, "31.12.2026") +
      legalFieldHtml("legal-f-days", "Срок оплаты, дней", f.payment_days, "30") +
      legalFieldHtml("legal-f-object", "Объект", f.object_name, "название или адрес объекта") +
      "</div>" +
      (legalDadataHint(st.data)
        ? '<div class="small muted mt-8">По ИНН из DaData: ' +
          esc(legalDadataHint(st.data)) + "</div>"
        : "") +
      '<p class="small muted mt-8">Если реквизита нет в тексте договора, он будет добавлен ' +
      "отдельным приложением «Реквизиты и условия сторон».</p>" +
      '<div class="small" id="legal-apply-status" style="min-height:18px;color:#B91C1C;"></div>' +
      '<div class="flex mt-16" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-navy" id="legal-apply" type="button">' +
      "Сформировать исправленный договор</button>" +
      '<button class="btn btn-outline" id="legal-back-a" type="button">← Назад к замечаниям</button>' +
      '<button class="btn btn-outline" id="legal-step-b-close" type="button">Закрыть</button></div>');
    var applyBtn = $("#legal-apply");
    if (applyBtn) applyBtn.addEventListener("click", applyLegalV2);
    var back = $("#legal-back-a");
    if (back) back.addEventListener("click", function () { openLegalStepA(st.data || {}); });
    var close = $("#legal-step-b-close");
    if (close) close.addEventListener("click", closeModal);
  }

  function readLegalFields() {
    var mapping = [
      ["customer_name", "legal-f-customer"],
      ["customer_inn", "legal-f-customer-inn"],
      ["contractor_name", "legal-f-contractor"],
      ["contractor_inn", "legal-f-contractor-inn"],
      ["amount", "legal-f-amount"],
      ["contract_date", "legal-f-date"],
      ["start_date", "legal-f-start"],
      ["end_date", "legal-f-end"],
      ["payment_days", "legal-f-days"],
      ["object_name", "legal-f-object"],
    ];
    var fields = {};
    mapping.forEach(function (pair) {
      var node = $("#" + pair[1]);
      var value = node ? String(node.value || "").trim() : "";
      if (value) fields[pair[0]] = value;
    });
    return fields;
  }

  /// Отправка выбранных правок и реквизитов → готовый .docx.
  async function applyLegalV2() {
    var st = legalV2State();
    var data = st.data || {};
    var base = legalEngineBase();
    var button = $("#legal-apply");
    var status = $("#legal-apply-status");
    if (!base) { if (status) status.textContent = "Воркер не настроен"; return; }
    if (button) { button.disabled = true; button.textContent = "Формируем .docx…"; }
    if (status) status.textContent = "";
    try {
      var session = (await sb.auth.getSession()).data.session;
      if (!session) throw new Error("Сессия истекла — войдите заново");
      var payload = {
        text: String(data.text || ""),
        original_fields: data.fields || {},
        fields: readLegalFields(),
        selected_issues: st.selected || [],
        file_name: (data.document && data.document.name) ||
          (st.file && st.file.name) || "contract.docx",
      };
      if (data.document && data.document.path) payload.document = data.document;
      else if (st.file) payload.file_base64 = await legalFileBase64(st.file);
      var resp = await fetch(base + "/api/contracts/apply-edits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: CFG.supabaseAnonKey,
        },
        body: JSON.stringify(payload),
      });
      var result = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !result || result.ok !== true || !result.docx_base64) {
        throw new Error((result && (result.error || result.detail || result.message)) ||
          ("HTTP " + resp.status));
      }
      legalDownloadDocx(result);
      closeModal();
      showLegalResult(result);
    } catch (e) {
      var message = "Договор не сформирован: " + ((e && e.message) || e);
      if (status) status.textContent = message;
      else toast(message, 9000);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Сформировать исправленный договор";
      }
    }
  }

  function legalDownloadDocx(result) {
    var binary = atob(result.docx_base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = result.file_name || "dogovor_ispravlennyy.docx";
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  function showLegalResult(result) {
    var applied = Array.isArray(result.applied_replacements) ? result.applied_replacements : [];
    var appendix = Array.isArray(result.appendix) ? result.appendix : [];
    var notes = Array.isArray(result.manual_notes) ? result.manual_notes : [];
    openModal("Исправленный договор готов",
      '<div class="card" style="padding:12px;">' +
      "<div><strong>" + esc(result.file_name || "договор.docx") + "</strong></div>" +
      '<div class="small muted mt-8">Файл скачан. Замен в тексте: ' + applied.length +
      " · изменённых абзацев: " + num(result.changed_paragraphs) + "</div></div>" +
      (notes.length
        ? '<div class="small muted mt-8">В лист «Замечания ИИ-юриста» добавлено: ' +
          notes.length + "</div>"
        : "") +
      (appendix.length
        ? '<div class="small muted mt-8">Добавлено приложением: ' +
          esc(appendix.map(function (row) { return row.label + " — " + row.value; }).join("; ")) +
          "</div>"
        : "") +
      (result.storage_path
        ? '<div class="small muted mt-8">Сохранено в облаке: ' +
          esc(result.storage_path) + "</div>"
        : "") +
      '<div class="flex mt-16"><button class="btn btn-navy" id="legal-result-ok" type="button">' +
      "Понятно</button></div>");
    var ok = $("#legal-result-ok");
    if (ok) ok.addEventListener("click", closeModal);
  }


  /// V194.6.2 (ТЗ §1): реальный предпросмотр договора — лист А4 с реквизитами,
  /// разделами и Приложением № 1. Никаких технических имён шаблонов и «₽ ₽».
  function contractTemplateTitle(template) {
    return String(template || "simple") === "full"
      ? "Полный договор строительного подряда"
      : "Упрощённый договор подряда";
  }

  var RU_CONTRACT_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  /// Дата договора в русском формате: «24» ноября 2026 г.
  function ruContractDate(value) {
    var parsed = String(value || "").slice(0, 10);
    var match = parsed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    var month = RU_CONTRACT_MONTHS[Number(match[2]) - 1] || "";
    return "«" + String(Number(match[3])) + "» " + month + " " + match[1] + " г.";
  }

  function contractSubjectPhrase(subject) {
    var text = String(subject || "строительно-монтажных работ").trim();
    if (!text) text = "строительно-монтажных работ";
    return /^выполнени/i.test(text) ? text : "Выполнение " + text;
  }

  function contractPartyTitle(role) {
    return String(role || "customer") === "contractor"
      ? "Мы — Подрядчик (контрагент — Заказчик)"
      : "Мы — Заказчик (контрагент — Подрядчик)";
  }

  /// Реквизиты стороны: организация/ИП, руководитель, должность, ИНН.
  function contractPartyHtml(title, party, isOurOrg) {
    var name = String((party && party.name) || "").trim() || "Контрагент не указан";
    var inn = String((party && party.inn) || "").replace(/\D+/g, "");
    var director = String((party && party.director) || "").trim();
    var position = String((party && party.position) || "").trim();
    return '<div class="contract-party">' +
      '<div class="contract-party-title">' + esc(title) +
      (isOurOrg ? " (наша организация)" : "") + "</div>" +
      '<div class="contract-party-name">' + esc(name) + "</div>" +
      (director ? '<div class="contract-party-line">' + esc(position || "Руководитель") +
        ": " + esc(director) + "</div>" : "") +
      (inn ? '<div class="contract-party-line">ИНН ' + esc(inn) + "</div>" : "") +
      '<div class="contract-party-sign">Подпись ________________ / ______________ /</div>' +
      "</div>";
  }

  function contractItemsTableHtml(row, amount) {
    var items = Array.isArray(row.items) ? row.items.filter(function (item) {
      return item && String(item.name || "").trim();
    }) : [];
    if (!items.length) {
      return '<table class="contract-table"><tbody>' +
        '<tr><td>1</td><td>' + esc(contractSubjectPhrase(row.subject)) +
        "</td><td>компл.</td><td>1</td><td class=\"num\">" + money(amount) +
        '</td><td class="num">' + money(amount) + "</td></tr>" +
        '<tr class="contract-total"><td colspan="5">Итого по Приложению № 1</td>' +
        '<td class="num">' + money(amount) + "</td></tr></tbody></table>";
    }
    var rows = items.map(function (item, index) {
      var qty = num(item.qty);
      var price = num(item.price);
      return "<tr><td>" + (index + 1) + "</td><td>" + esc(item.name) + "</td><td>" +
        esc(item.unit || "—") + '</td><td class="num">' + qty + '</td>' +
        '<td class="num">' + money(price) + '</td><td class="num">' +
        money(round2(qty * price)) + "</td></tr>";
    }).join("");
    return '<table class="contract-table"><thead><tr><th>№</th>' +
      '<th>Наименование работ / этап</th><th>Ед.</th><th class="num">Кол-во</th>' +
      '<th class="num">Цена</th><th class="num">Сумма</th></tr></thead><tbody>' + rows +
      '<tr class="contract-total"><td colspan="5">Итого по Приложению № 1</td>' +
      '<td class="num">' + money(amount) + "</td></tr></tbody></table>";
  }


  async function renderContractDocument(row, contractId) {
    var orgRow = state.orgRow || null;
    if (!orgRow && state.orgId) {
      var orgRes = await sb.from("organizations").select("*")
        .eq("id", state.orgId).maybeSingle();
      state.orgRow = orgRes.data || null;
      orgRow = state.orgRow;
    }
    var org = orgRow || {};
    var role = String(row.role || "customer") === "contractor" ? "contractor" : "customer";
    var ourName = String(org.name || state.orgName || "").trim();
    var ourInn = String(org.inn || "").replace(/\D+/g, "");
    var ourDirector = String(org.director_name || org.head_name || "").trim();
    var ourPosition = String(org.director_position || org.head_position || "").trim();
    // Ролевая модель: «мы» — всегда наша организация, контрагент — вторая сторона.
    var us = {
      name: role === "customer" ? (row.customer_name || ourName) : (row.contractor_name || ourName),
      inn: role === "customer" ? (row.customer_inn || ourInn) : (row.contractor_inn || ourInn),
      director: ourDirector, position: ourPosition,
    };
    if (!us.name) us.name = ourName;
    if (!us.inn) us.inn = ourInn;
    var other = {
      name: role === "customer" ? (row.contractor_name || "") : (row.customer_name || ""),
      inn: role === "customer" ? (row.contractor_inn || "") : (row.customer_inn || ""),
    };
    // Запрет подстановки нашей организации в обе стороны (старые записи).
    if (ourName && String(other.name).trim().toLowerCase() === ourName.toLowerCase()) {
      other.name = "";
    }
    var customer = role === "customer" ? us : other;
    var contractor = role === "contractor" ? us : other;
    var amount = num(row.amount);
    var vat = num(row.vat_rate);
    var vatSum = vat > 0 ? round2(amount * vat / 100) : 0;
    var dateText = ruContractDate(row.contract_date);
    var city = String(org.city || "").trim();
    var objectLine = String(row.object_name || "").trim();
    var address = String(row.object_address || "").trim();
    var templateTitle = contractTemplateTitle(row.template);
    var headerMeta = [];
    if (city) headerMeta.push("г. " + city);
    if (dateText) headerMeta.push(dateText);

    openModal("Предпросмотр договора",
      '<div class="contract-sheet" id="contract-sheet">' +
      '<div class="contract-doc">' +
      '<div class="contract-title">ДОГОВОР ПОДРЯДА № ' + esc(row.number || "б/н") + "</div>" +
      (headerMeta.length
        ? '<div class="contract-meta">' + esc(headerMeta.join(" · ")) + "</div>" : "") +
      '<p class="contract-text">' + esc(us.name || "Подрядчик") +
      ", именуемое в дальнейшем «" + (role === "customer" ? "Заказчик" : "Подрядчик") +
      "», с одной стороны, и " + esc(other.name || "контрагент") +
      ", именуемое в дальнейшем «" + (role === "customer" ? "Подрядчик" : "Заказчик") +
      "», с другой стороны, заключили настоящий договор о нижеследующем.</p>" +
      '<h4 class="contract-h">1. Предмет договора</h4>' +
      '<p class="contract-text">1.1. ' + (role === "customer" ? "Подрядчик" : "Заказчик") +
      " обязуется выполнить: " + esc(contractSubjectPhrase(row.subject)) +
      (objectLine ? ", на объекте «" + esc(objectLine) + "»" : "") +
      (address ? ", по адресу: " + esc(address) : "") + ".</p>" +
      '<p class="contract-text">1.2. Объём работ и договорные расценки определены ' +
      "Приложением № 1 к настоящему договору.</p>" +
      '<h4 class="contract-h">2. Цена договора и порядок расчётов</h4>' +
      '<p class="contract-text">2.1. Цена договора составляет <strong>' + money(amount) +
      "</strong>" + (vat > 0
        ? ", в том числе НДС " + vat + " % — " + money(vatSum) + "."
        : ", НДС не облагается.") + "</p>" +
      '<p class="contract-text">2.2. Расчёты производятся по актам КС-2 и справке КС-3, ' +
      "безналичным перечислением.</p>" +
      '<h4 class="contract-h">3. Сроки и гарантия</h4>' +
      '<p class="contract-text">3.1. Сроки выполнения работ определяются графиком ' +
      "производства работ (ГПР).</p>" +
      '<p class="contract-text">3.2. Гарантия на результат работ — 24 месяца с даты ' +
      "подписания акта КС-2.</p>" +
      '<h4 class="contract-h">4. Реквизиты и подписи сторон</h4>' +
      '<div class="contract-parties">' +
      contractPartyHtml("Заказчик", customer, role === "customer") +
      contractPartyHtml("Подрядчик", contractor, role === "contractor") +
      "</div>" +
      '<h4 class="contract-h">Приложение № 1. Ведомость объёмов и договорных расценок</h4>' +
      contractItemsTableHtml(row, amount) +
      "</div></div>" +
      '<div class="contract-note">' + esc(templateTitle) +
      ". Проверьте реквизиты, суммы и условия перед подписанием документа.</div>" +
      '<div class="flex mt-16 contract-actions" style="gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-navy" id="contract-preview-download" type="button">Скачать .docx</button>' +
      '<button class="btn btn-outline" id="contract-preview-ai" type="button">Проверить ИИ-юристом</button>' +
      '<button class="btn btn-outline" id="contract-preview-print" type="button">Печать</button>' +
      '<button class="btn btn-ghost" id="contract-preview-close" type="button">Закрыть</button></div>',
      "doc");

    var download = $("#contract-preview-download");
    if (download) download.addEventListener("click", function () {
      closeModal();
      downloadContract(contractId);
    });
    var ai = $("#contract-preview-ai");
    if (ai) ai.addEventListener("click", function () {
      openLegalReviewModal([row], contractId);
    });
    var print = $("#contract-preview-print");
    if (print) print.addEventListener("click", printContractSheet);
    var close = $("#contract-preview-close");
    if (close) close.addEventListener("click", closeModal);
  }

  /// Печать только листа договора (без интерфейса портала).
  function printContractSheet() {
    document.body.classList.add("printing-contract");
    window.print();
    window.setTimeout(function () {
      document.body.classList.remove("printing-contract");
    }, 600);
  }


  /// V194.5.6-E (ТЗ §4): роли сторон + ведомость объёмов и расценок в договоре.
  /// `role = customer` — мы Заказчик (контрагент из «Подрядчиков» становится
  /// Подрядчиком); `role = contractor` — мы Подрядчик.
  function contractRoleTitle(role) {
    return role === "contractor" ? "Мы — Подрядчик (договор с заказчиком)"
      : "Мы — Заказчик (договор с подрядчиком)";
  }

  function contractItemsSum() {
    var total = 0;
    $all("[data-ct-item-row]").forEach(function (row) {
      var qty = num((row.querySelector("[data-ct-qty]") || {}).value);
      var price = num((row.querySelector("[data-ct-price]") || {}).value);
      total += Math.round(qty * price * 100) / 100;
    });
    return Math.round(total * 100) / 100;
  }

  function contractItemsPayload() {
    var items = [];
    $all("[data-ct-item-row]").forEach(function (row) {
      var name = String((row.querySelector("[data-ct-name]") || {}).value || "").trim();
      if (!name) return;
      var qty = num((row.querySelector("[data-ct-qty]") || {}).value);
      var price = num((row.querySelector("[data-ct-price]") || {}).value);
      items.push({
        name: name,
        unit: String((row.querySelector("[data-ct-unit]") || {}).value || "").trim(),
        qty: qty, price: price, total: Math.round(qty * price * 100) / 100,
      });
    });
    return items;
  }

  function contractItemRowHtml() {
    return '<tr data-ct-item-row>' +
      '<td><input type="text" data-ct-name placeholder="Этап / вид работ" /></td>' +
      '<td><input type="text" data-ct-unit placeholder="ед." style="max-width:70px;" /></td>' +
      '<td><input type="number" step="0.0001" data-ct-qty value="1" style="max-width:90px;" /></td>' +
      '<td><input type="number" step="0.01" data-ct-price value="0" style="max-width:120px;" /></td>' +
      '<td><button class="btn btn-ghost btn-sm" data-ct-remove type="button">✕</button></td></tr>';
  }

  function contractItemsRecalc() {
    var total = contractItemsSum();
    var amount = $("#ct-amount");
    if (amount) amount.value = total ? total.toFixed(2) : "0";
    var label = $("#ct-items-total");
    if (label) label.textContent = money(total) + " ₽";
  }

  function wireContractItemInputs() {
    $all("#ct-items-body input").forEach(function (input) {
      input.oninput = contractItemsRecalc;
    });
    $all("[data-ct-remove]").forEach(function (btn) {
      btn.onclick = function () {
        var row = btn.closest("[data-ct-item-row]");
        if (row) row.remove();
        contractItemsRecalc();
      };
    });
  }

  function wireContractItems() {
    var add = $("#ct-item-add");
    if (add) {
      add.addEventListener("click", function () {
        var body = $("#ct-items-body");
        if (!body) return;
        body.insertAdjacentHTML("beforeend", contractItemRowHtml());
        wireContractItemInputs();
      });
    }
    wireContractItemInputs();
  }

  function openContractModal() {
    var project = activeProject();
    // V194.5.6-D (ТЗ §3): контрагент выбирается из уже добавленных подрядчиков
    // (с автоподстановкой реквизитов) либо вводится вручную.
    var list = state.orgContractors || [];
    var pickOptions = '<option value="">— выбрать из подрядчиков —</option>' +
      list.map(function (row, index) {
        return '<option value="' + index + '">' + esc(row.full_name || "Подрядчик") +
          (row.city ? " · " + esc(row.city) : "") + "</option>";
      }).join("");
    openModal("Новый договор",
      // V194.5.6-E (ТЗ §4): роль сторон — переключатель в начале формы.
      '<label class="field"><span>Роль сторон</span><select id="ct-role">' +
      '<option value="customer" selected>' + contractRoleTitle("customer") + '</option>' +
      '<option value="contractor">' + contractRoleTitle("contractor") + '</option>' +
      "</select></label>" +
      '<div class="form-row">' +
      '<label class="field"><span>Номер договора</span>' +
      '<input type="text" id="ct-number" placeholder="14/2026" /></label>' +
      '<label class="field"><span>Дата</span>' +
      '<input type="date" id="ct-date" value="' + new Date().toISOString().slice(0, 10) + '" /></label>' +
      '<label class="field"><span>Контрагент из подрядчиков</span>' +
      '<select id="ct-customer-pick">' + pickOptions + "</select></label>" +
      '<label class="field"><span id="ct-party-label">Контрагент (Подрядчик)</span>' +
      '<input type="text" id="ct-customer" placeholder="ООО «Контрагент»" /></label>' +
      '<label class="field"><span>ИНН контрагента</span>' +
      '<input type="text" id="ct-customer-inn" placeholder="10 или 12 цифр" /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Предмет договора</span>' +
      '<input type="text" id="ct-subject" value="строительно-монтажных работ" /></label>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Объект</span>' +
      '<input type="text" id="ct-object" value="' + esc((project && project.name) || "") + '" /></label>' +
      '<label class="field"><span>Адрес объекта</span>' +
      '<input type="text" id="ct-address" value="' +
      esc([project && project.city, project && project.address].filter(Boolean).join(", ")) +
      '" /></label>' +
      '<label class="field"><span>Сумма договора, ₽ (из ведомости)</span>' +
      '<input type="number" step="0.01" id="ct-amount" value="0" /></label>' +
      '<label class="field"><span>НДС, %</span><select id="ct-vat">' +
      [0, 5, 7, 10, 22].map(function (rate) {
        return '<option value="' + rate + '"' + (rate === 22 ? " selected" : "") + ">" +
          rate + "%</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Шаблон</span><select id="ct-template">' +
      '<option value="simple">Упрощённый договор подряда</option>' +
      '<option value="full">Полный договор строительного подряда</option></select></label>' +
      "</div>" +
      '<div class="small" id="ct-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<h4 class="mt-16" style="margin-bottom:6px;">Ведомость объёмов и расценок ' +
      "(Приложение № 1)</h4>" +
      '<div class="table-wrap" style="max-height:34vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Наименование этапа / работ</th><th>Ед.</th>' +
      '<th>Кол-во</th><th>Цена, ₽</th><th></th></tr></thead><tbody id="ct-items-body">' +
      contractItemRowHtml() + "</tbody></table></div>" +
      '<div class="flex-between mt-8"><button class="btn btn-outline btn-sm" ' +
      'id="ct-item-add" type="button">+ Добавить строку</button>' +
      '<span class="small">Итого по ведомости: <strong id="ct-items-total">0 ₽</strong></span></div>' +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="ct-save" type="button">' +
      "Сохранить договор</button></div>");
    wireContractItems();
    var roleSelect = $("#ct-role");
    var partyLabel = $("#ct-party-label");
    if (roleSelect) {
      roleSelect.addEventListener("change", function () {
        if (partyLabel) {
          partyLabel.textContent = roleSelect.value === "contractor"
            ? "Контрагент (Заказчик)" : "Контрагент (Подрядчик)";
        }
      });
    }
    var pick = $("#ct-customer-pick");
    if (pick) {
      pick.addEventListener("change", function () {
        var index = num(pick.value);
        var picked = pick.value === "" ? null : list[index];
        if (!picked) return;
        // V194.5.6-E (ТЗ §4): выбрали подрядчика → мы автоматически Заказчик,
        // а выбранный человек становится Подрядчиком (раньше было наоборот).
        if (roleSelect) {
          roleSelect.value = "customer";
          if (partyLabel) partyLabel.textContent = "Контрагент (Подрядчик)";
        }
        var nameField = $("#ct-customer");
        if (nameField) nameField.value = picked.full_name || "";
        var innField = $("#ct-customer-inn");
        if (innField && picked.inn) innField.value = String(picked.inn).replace(/\D+/g, "");
        var objectField = $("#ct-object");
        if (objectField && !objectField.value && picked.city) {
          objectField.value = picked.city;
        }
      });
    }
    var addBtn = $("#ct-save");
    if (!addBtn) return;
    addBtn.addEventListener("click", async function () {
      var number = String($("#ct-number").value || "").trim();
      var customer = String($("#ct-customer").value || "").trim();
      var errorNode = $("#ct-error");
      if (!customer) {
        if (errorNode) errorNode.textContent = "Укажите контрагента";
        return;
      }
      // V194.5.6-E (ТЗ §4): роль и ведомость сохраняются вместе с договором,
      // чтобы .docx собирался с правильными сторонами и Приложением № 1.
      var role = roleSelect ? roleSelect.value : "customer";
      var items = contractItemsPayload();
      var counterpartyInn = String($("#ct-customer-inn").value || "").replace(/\D+/g, "");
      var ourName = String(state.orgName || "").trim();
      var ourInn = String((state.orgRow && state.orgRow.inn) || "").replace(/\D+/g, "");
      var payload = {
        organization_id: state.orgId,
        number: number || "б/н",
        contract_date: String($("#ct-date").value || "").trim() || null,
        role: role,
        items: items,
        customer_name: role === "customer" ? (ourName || customer) : customer,
        customer_inn: role === "customer" ? ourInn : counterpartyInn,
        contractor_name: role === "customer" ? customer : ourName,
        contractor_inn: role === "customer" ? counterpartyInn : ourInn,
        subject: String($("#ct-subject").value || "").trim(),
        object_name: String($("#ct-object").value || "").trim(),
        object_address: String($("#ct-address").value || "").trim(),
        amount: num($("#ct-amount").value) || contractItemsSum(),
        vat_rate: num($("#ct-vat").value),
        template: $("#ct-template").value,
        status: "draft",
        created_by: state.userId || null,
      };
      var ins = await sb.from("org_contracts").insert(payload).select("id").maybeSingle();
      if (ins.error) {
        if (errorNode) errorNode.textContent = "Не сохранено: " + ins.error.message;
        return;
      }
      closeModal();
      toast("Договор добавлен в реестр");
      renderRoute();
    });
  }

  async function deleteContract(contractId) {
    var id = num(contractId);
    if (!id) return;
    if (!window.confirm("Удалить договор из реестра? Сгенерированный файл останется в облаке.")) return;
    var res = await sb.from("org_contracts").delete()
      .eq("id", id).eq("organization_id", state.orgId);
    if (res.error) { toast("Не удалено: " + res.error.message, 7000); return; }
    toast("Договор удалён из реестра");
    renderRoute();
  }

  /// Скачивание договора: эндпоинт воркера `/api/documents/contract` (шаблоны .docx).
  async function downloadContract(contractId) {
    var id = num(contractId);
    if (!id) return;
    var row = null;
    try {
      var res = await sb.from("org_contracts").select("*").eq("id", id)
        .eq("organization_id", state.orgId).maybeSingle();
      row = res.data || null;
    } catch (e) { /* ниже — понятная ошибка */ }
    if (!row) { toast("Договор не найден"); return; }
    var orgRow = state.orgRow || null;
    if (!orgRow) {
      var orgRes = await sb.from("organizations").select("*")
        .eq("id", state.orgId).maybeSingle();
      state.orgRow = orgRes.data || null;
      orgRow = state.orgRow;
    }
    var session = (await sb.auth.getSession()).data.session;
    var base = String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
    if (!base || !session) { toast("Воркер или сессия недоступны"); return; }
    var payload = {
      template: row.template || "simple",
      role: row.role || "customer",
      contract: {
        number: row.number, date: row.contract_date, subject: row.subject,
        amount: row.amount, vat_rate: row.vat_rate,
        role: row.role || "customer",
        items: row.items || [],
        customer_name: row.customer_name, customer_inn: row.customer_inn,
        contractor_name: row.contractor_name, contractor_inn: row.contractor_inn,
        object_name: row.object_name, object_address: row.object_address,
      },
      organization: orgRow || {},
      contractor: {
        name: row.contractor_name || "",
        full_name: row.contractor_name || "",
        inn: row.contractor_inn || "",
      },
    };
    toast("Формируем договор…");
    try {
      var resp = await fetch(base + "/api/documents/contract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
          apikey: CFG.supabaseAnonKey,
        },
        body: JSON.stringify(payload),
      });
      var data = await resp.json();
      if (!resp.ok || !data || data.ok !== true || !data.docx_base64) {
        throw new Error((data && (data.detail || data.error)) || ("HTTP " + resp.status));
      }
      var binary = atob(data.docx_base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = data.file_name || "dogovor.docx";
      document.body.appendChild(link);
      link.click();
      setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      if (data.storage_path) {
        await sb.from("org_contracts").update({ storage_path: data.storage_path })
          .eq("id", id).eq("organization_id", state.orgId);
      }
      toast("Договор скачан");
    } catch (e) {
      toast("Договор не сформирован: " + ((e && e.message) || e), 8000);
    }
  }

  async function renderContractors(root) {
    if (!(await requireAuth(root))) return;
    // V194.5.6-B (ТЗ §2): вкладка «Договоры» — реестр и генерация .docx.
    if (state.contractsTab === "contracts") {
      await renderContracts(root);
      return;
    }
    root.innerHTML = '<div class="muted">Загрузка базы бригад…</div>';
    // V194.5.5-B (ТЗ §2): только приватная база подрядчиков своей организации.
    var res = await sb.from("org_contractors").select("*")
      .eq("org_id", state.orgId)
      .order("created_at", { ascending: false }).limit(500);
    if (res.error) {
      root.innerHTML = '<div class="warn-box">Не удалось прочитать базу бригад: ' +
        esc(res.error.message) + "</div>";
      return;
    }
    var rows = res.data || [];
    state.orgContractors = rows;
    var filters = state.contractorFilters || (state.contractorFilters = { q: "", city: "" });
    var cities = {};
    rows.forEach(function (row) { if (row.city) cities[row.city] = true; });

    root.innerHTML =
      '<div class="flex-between mt-16"><div><h2 class="section-title" style="margin:0;">Подрядчики и Договоры</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Проверенные подрядчики и бригадиры организации: ' +
      "телефон, специализация, город, оценка и комментарии прорабов.</p></div>" +
      '<button class="btn btn-navy" id="contractor-add" type="button">Добавить подрядчика</button></div>' +
      contractsTabsHtml("contractors") +
      '<div class="form-row mt-16">' +
      '<label class="field"><span>Поиск по виду работ или ФИО</span>' +
      '<input type="text" id="contractor-q" value="' + esc(filters.q) + '" placeholder="кровля, монолит, Иванов" /></label>' +
      '<label class="field"><span>Город</span><select id="contractor-city"><option value="">Все города</option>' +
      Object.keys(cities).sort().map(function (city) {
        return '<option value="' + esc(city) + '"' + (filters.city === city ? " selected" : "") + ">" +
          esc(city) + "</option>";
      }).join("") + "</select></label></div>" +
      '<div class="card mt-16"><div class="table-wrap" style="max-height:56vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Подрядчик</th><th>Специализация</th><th>Город</th>' +
      '<th class="num">Бригада</th><th>Оценка</th><th>Комментарий</th><th></th></tr></thead><tbody id="contractor-rows">' +
      contractorRowsHtml(rows, filters) + "</tbody></table></div></div>";

    $("#contractor-add").addEventListener("click", function () { openContractorModal(null); });
    $("#contractor-q").addEventListener("input", function () {
      filters.q = $("#contractor-q").value.trim().toLowerCase();
      $("#contractor-rows").innerHTML = contractorRowsHtml(state.orgContractors, filters);
      bindContractorRows(root);
    });
    $("#contractor-city").addEventListener("change", function () {
      filters.city = $("#contractor-city").value;
      $("#contractor-rows").innerHTML = contractorRowsHtml(state.orgContractors, filters);
      bindContractorRows(root);
    });
    bindContractorRows(root);
    bindContractsTabs();
  }

  function openContractorModal(row) {
    var isEdit = !!row;
    var specs = CONTRACTOR_SPECIALIZATIONS.map(function (item) {
      return "<option" + (isEdit && row.specialization === item ? " selected" : "") + ">" + esc(item) + "</option>";
    }).join("");
    var ratingOptions = [5, 4, 3, 2, 1].map(function (value) {
      return '<option value="' + value + '"' + (isEdit && num(row.rating) === value ? " selected" : "") + ">" +
        value + " ★</option>";
    }).join("");
    openModal(isEdit ? "Подрядчик" : "Новый подрядчик",
      '<div class="form-row">' +
      '<label class="field"><span>ФИО</span><input type="text" id="c-name" value="' + esc(isEdit ? row.full_name : "") + '" /></label>' +
      '<label class="field"><span>Телефон</span><input type="tel" id="c-phone" value="' + esc(isEdit ? row.phone : "") + '" placeholder="+7 900 000-00-00" /></label>' +
      '<label class="field"><span>Специализация</span><select id="c-spec">' + specs + "</select></label>" +
      '<label class="field"><span>Город</span><input type="text" id="c-city" value="' + esc(isEdit ? row.city || "" : "") + '" /></label>' +
      '<label class="field"><span>Размер бригады</span><input type="number" min="1" id="c-brigade" value="' + (isEdit ? num(row.brigade_size) || 1 : 1) + '" /></label>' +
      '<label class="field"><span>Оценка</span><select id="c-rating">' + ratingOptions + "</select></label>" +
      "</div>" +
      '<label class="field mt-8"><span>Комментарий прораба / директора</span>' +
      '<input type="text" id="c-notes" value="' + esc(isEdit ? row.notes || "" : "") + '" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="c-save" type="button">Сохранить</button></div>');
    $("#c-save").addEventListener("click", async function () {
      var payload = {
        org_id: state.orgId,
        full_name: String($("#c-name").value || "").trim(),
        phone: String($("#c-phone").value || "").trim(),
        specialization: $("#c-spec").value,
        city: String($("#c-city").value || "").trim() || null,
        brigade_size: Math.max(1, Math.round(num($("#c-brigade").value) || 1)),
        rating: Math.round(num($("#c-rating").value) || 5),
        notes: String($("#c-notes").value || "").trim() || null,
        created_by: state.userId,
      };
      if (!payload.full_name || !payload.phone) { toast("Укажите ФИО и телефон"); return; }
      var res = isEdit
        ? await sb.from("org_contractors").update(payload).eq("id", row.id)
        : await sb.from("org_contractors").insert(payload);
      if (res.error) { toast("Не сохранено: " + res.error.message, 7000); return; }
      closeModal();
      toast(isEdit ? "Подрядчик обновлён" : "Подрядчик добавлен");
      renderRoute();
    });
  }


  // ───────────────────────── Биржа подрядов ─────────────────────────
// ═════════ V192.9: Биржа подрядов в стиле Авито (медиа, галерея, MAX) ═════════
  function marketplaceTypeTitleShort(type) {
    return type === "brigade_available" ? "Бригада" : "Ищу подрядчика";
  }

  /// V194.5.3 (ТЗ §3.2): срок объявления — 30 дней с публикации/продления.
  function marketplaceExpiresAt(post) {
    var raw = String((post && (post.extended_until || post.expires_at)) || "").trim();
    if (raw) {
      var parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    var created = new Date(String((post && post.created_at) || ""));
    if (isNaN(created.getTime())) return null;
    return new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  function marketplaceIsExpired(post) {
    var until = marketplaceExpiresAt(post);
    return !!until && until.getTime() < Date.now();
  }

  async function archiveMarketplacePost(postId) {
    var upd = await sb.from("marketplace_posts").update({ status: "archived" }).eq("id", postId);
    if (upd.error) { toast("Не удалось снять с публикации: " + upd.error.message, 7000); return; }
    closeModal();
    toast("Объявление снято с публикации");
    renderRoute();
  }

  async function deleteMarketplacePost(postId) {
    var del = await sb.from("marketplace_posts").delete().eq("id", postId);
    if (del.error) { toast("Не удалось удалить: " + del.error.message, 7000); return; }
    closeModal();
    toast("Объявление удалено");
    renderRoute();
  }

  function bindPostActions(root, posts) {
    var byId = {};
    (posts || state.marketplacePosts || []).forEach(function (post) { byId[String(post.id)] = post; });
    $all("[data-post-open]", root).forEach(function (card) {
      card.addEventListener("click", function (event) {
        if (event.target && event.target.closest && event.target.closest("button, a")) return;
        openPostDetail(byId[card.getAttribute("data-post-open")]);
      });
    });
    $all("[data-post-archive]", root).forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        archiveMarketplacePost(btn.getAttribute("data-post-archive"));
      });
    });
    $all("[data-post-delete]", root).forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        deleteMarketplacePost(btn.getAttribute("data-post-delete"));
      });
    });
    bindMaxButtons(root);
  }


  /// V193.2: сжатие фото до 1600 px / JPEG 82 % перед загрузкой в Бакет.
  /// 6–8 МБ превращаются в 200–350 КБ и открываются мгновенно.
  function compressMarketplaceImage(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//i.test(file.type || "") ||
          /gif|svg/i.test(file.type || "")) {
        resolve(file);
        return;
      }
      var objectUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var maxSide = 1600;
          var width = img.naturalWidth || img.width;
          var height = img.naturalHeight || img.height;
          if (width > maxSide || height > maxSide) {
            if (width >= height) {
              height = Math.round(height * maxSide / width);
              width = maxSide;
            } else {
              width = Math.round(width * maxSide / height);
              height = maxSide;
            }
          }
          var canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(objectUrl);
            if (!blob) { resolve(file); return; }
            var name = String(file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
            resolve(new File([blob], name, { type: "image/jpeg" }));
          }, "image/jpeg", 0.82);
        } catch (e) {
          URL.revokeObjectURL(objectUrl);
          resolve(file);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        resolve(file);
      };
      img.src = objectUrl;
    });
  }

  async function uploadMarketplaceMedia(files, counterNode) {
    var list = Array.prototype.slice.call(files || []).slice(0, 5);
    var urls = [];
    for (var i = 0; i < list.length; i++) {
      var original = list[i];
      if (counterNode) counterNode.textContent = "Загрузка " + (i + 1) + " из " + list.length + "…";
      var file = await compressMarketplaceImage(original);
      var safe = sanitizeStorageKey(file.name || ("media_" + (i + 1)));
      var path = (state.userId || "anon") + "/" + Date.now() + "_" + (i + 1) + "_" + safe;
      var up = await sb.storage.from("marketplace_media")
        .upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (up.error) {
        toast("«" + (original.name || file.name) + "» не загружено: " + up.error.message, 7000);
        continue;
      }
      var pub = sb.storage.from("marketplace_media").getPublicUrl(path);
      var url = (pub && pub.data && pub.data.publicUrl) || "";
      if (url) urls.push(url);
    }
    if (counterNode) counterNode.textContent = urls.length ? "Готово: " + urls.length + " вложений" : "";
    return urls;
  }

  function openMarketplaceModal() {
    var specs = CONTRACTOR_SPECIALIZATIONS.map(function (item) {
      return "<option>" + esc(item) + "</option>";
    }).join("");
    openModal("Объявление на Бирже подрядов",
      '<div class="form-row">' +
      '<label class="field"><span>Тип</span><select id="mp-post-type">' +
      '<option value="need_contractor">Ищу подрядчика на объём</option>' +
      '<option value="brigade_available">Бригада ищет объём</option></select></label>' +
      '<label class="field"><span>Специализация</span><select id="mp-post-spec">' + specs + "</select></label>" +
      '<label class="field"><span>Город</span><input type="text" id="mp-post-city" placeholder="Москва" /></label>' +
      '<label class="field"><span>Срок публикации</span>' +
      '<input type="text" id="mp-post-expires" value="30 дней (стандарт Биржи)" disabled /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Заголовок</span><input type="text" id="mp-post-title" placeholder="Монолит 1 200 м³, ЖК «Северный»" /></label>' +
      '<label class="field mt-8"><span>Объём и условия</span><input type="text" id="mp-post-volume" placeholder="1 200 м³, сроки 2 месяца, оплата по этапам" /></label>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Бюджет / ставка (текстом)</span><input type="text" id="mp-post-budget" placeholder="от 4 500 ₽/м³" /></label>' +
      '<label class="field"><span>Готовность с</span><input type="date" id="mp-post-from" /></label>' +
      "</div>" +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Контактное лицо</span><input type="text" id="mp-post-name" value="' +
      esc((state.profile && state.profile.full_name) || "") + '" /></label>' +
      '<label class="field"><span>Телефон</span><input type="tel" id="mp-post-phone" placeholder="+7 900 000-00-00" /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Портфолио: до 5 фото или видео (JPG/PNG/WEBP/MP4)</span>' +
      '<input type="file" id="mp-media" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" /></label>' +
      '<div class="small muted mt-8" id="mp-media-status"></div>' +
      '<p class="small muted mt-8">Публикация — на 30 дней. Лимит активных объявлений: demo/бригадир — 1, ' +
      "Базовый — 3, Про/Безлимит — 15. Для бригадира нужно согласие 10.1 152-ФЗ.</p>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="mp-publish" type="button">Опубликовать</button></div>');
    $("#mp-publish").addEventListener("click", publishMarketplacePost);
  }

  async function publishMarketplacePost() {
    var payload = {
      author_user_id: state.userId,
      author_org_id: state.orgId || null,
      post_type: $("#mp-post-type").value,
      title: String($("#mp-post-title").value || "").trim(),
      specialization: $("#mp-post-spec").value,
      city: String($("#mp-post-city").value || "").trim(),
      volume_desc: String($("#mp-post-volume").value || "").trim() || null,
      budget_text: String($("#mp-post-budget").value || "").trim() || null,
      available_from: $("#mp-post-from").value || null,
      contact_name: String($("#mp-post-name").value || "").trim(),
      contact_phone: String($("#mp-post-phone").value || "").trim(),
      status: "active",
      // V192.9: стандартный срок Биржи — 30 дней.
      expires_at: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      media_urls: [],
    };
    if (!payload.title || !payload.city || !payload.contact_name || !payload.contact_phone) {
      toast("Заполните заголовок, город, контакт и телефон");
      return;
    }
    var btn = $("#mp-publish");
    if (btn) { btn.disabled = true; btn.textContent = "Публикуем…"; }
    var mediaInput = $("#mp-media");
    var statusNode = $("#mp-media-status");
    if (mediaInput && mediaInput.files && mediaInput.files.length) {
      payload.media_urls = await uploadMarketplaceMedia(mediaInput.files, statusNode);
    }
    var res = await sb.from("marketplace_posts").insert(payload);
    if (btn) { btn.disabled = false; btn.textContent = "Опубликовать"; }
    if (res.error) {
      toast(String(res.error.message).indexOf("row-level security") >= 0
        ? "Публикация недоступна: исчерпан тарифный лимит активных объявлений или нет согласия 10.1 152-ФЗ"
        : "Не опубликовано: " + res.error.message, 9000);
      return;
    }
    closeModal();
    toast("Объявление опубликовано на 30 дней");
    // V194.5.5-B: Биржа — самостоятельный раздел (#/marketplace), без contractorsTab.
    if (currentPath() !== "/marketplace") location.hash = "#/marketplace";
    else renderRoute();
  }

  /// V193.1: полноценное редактирование объявления автором (портал).
  /// Форма поднимает текущие данные и media_urls, позволяет удалять вложения и
  /// дозагружать новые (суммарно до 5), сохраняя их в marketplace_posts.
  function openMarketplaceEditModal(post) {
    if (!post) return;
    var media = Array.isArray(post.media_urls) ? post.media_urls.slice(0, 5) : [];
    var specs = CONTRACTOR_SPECIALIZATIONS.map(function (item) {
      return "<option" + (item === post.specialization ? " selected" : "") + ">" +
        esc(item) + "</option>";
    }).join("");
    openModal("Редактировать объявление",
      '<div class="form-row">' +
      '<label class="field"><span>Тип</span><select id="mp-edit-type">' +
      '<option value="need_contractor"' +
      (post.post_type === "need_contractor" ? " selected" : "") +
      ">Ищу подрядчика на объём</option>" +
      '<option value="brigade_available"' +
      (post.post_type === "brigade_available" ? " selected" : "") +
      ">Бригада ищет объём</option></select></label>" +
      '<label class="field"><span>Специализация</span><select id="mp-edit-spec">' +
      specs + "</select></label>" +
      '<label class="field"><span>Город</span><input type="text" id="mp-edit-city" value="' +
      esc(post.city || "") + '" /></label></div>' +
      '<label class="field mt-8"><span>Заголовок</span><input type="text" id="mp-edit-title" value="' +
      esc(post.title || "") + '" /></label>' +
      '<label class="field mt-8"><span>Объём и условия</span><input type="text" id="mp-edit-volume" value="' +
      esc(post.volume_desc || "") + '" /></label>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Бюджет / ставка</span><input type="text" id="mp-edit-budget" value="' +
      esc(post.budget_text || "") + '" /></label>' +
      '<label class="field"><span>Готовность с</span><input type="date" id="mp-edit-from" value="' +
      esc(String(post.available_from || "").slice(0, 10)) + '" /></label></div>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Контактное лицо</span><input type="text" id="mp-edit-name" value="' +
      esc(post.contact_name || "") + '" /></label>' +
      '<label class="field"><span>Телефон</span><input type="tel" id="mp-edit-phone" value="' +
      esc(post.contact_phone || "") + '" /></label></div>' +
      '<div class="small muted mt-8">Вложения: <span id="mp-edit-count">0</span> из 5</div>' +
      '<div class="flex mt-8" id="mp-edit-media"></div>' +
      '<label class="field mt-8"><span>Добавить фото/видео (до 5 суммарно)</span>' +
      '<input type="file" id="mp-edit-files" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" /></label>' +
      '<div class="small muted mt-8" id="mp-edit-status"></div>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="mp-edit-save" type="button">Сохранить</button></div>');

    var editorState = { urls: media, removed: [], files: [] };
    function renderChips() {
      var box = $("#mp-edit-media");
      if (!box) return;
      box.innerHTML = editorState.urls.length ? editorState.urls.map(function (url) {
        return '<span class="pill pill-info" style="display:inline-flex;gap:6px;align-items:center;">' +
          (isVideoUrl(url) ? "🎬 Видео" : "🖼 Фото") +
          '<button type="button" data-media-del="' + esc(url) + '" title="Удалить вложение" ' +
          'style="border:none;background:transparent;color:#B91C1C;cursor:pointer;font-weight:800;">×</button></span>';
      }).join("") : '<span class="small muted">Вложений нет</span>';
      var count = $("#mp-edit-count");
      if (count) count.textContent = String(editorState.urls.length + editorState.files.length);
      $all("[data-media-del]", box).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var url = btn.getAttribute("data-media-del");
          editorState.removed.push(url);
          editorState.urls = editorState.urls.filter(function (item) { return item !== url; });
          renderChips();
        });
      });
    }
    renderChips();
    var filesInput = $("#mp-edit-files");
    if (filesInput) filesInput.addEventListener("change", function () {
      editorState.files = Array.prototype.slice.call(filesInput.files || []);
      renderChips();
    });
    var saveBtn = $("#mp-edit-save");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      saveMarketplaceEdit(post, editorState);
    });
  }


  /// Сохранение правок объявления + догрузка новых вложений (до 5 суммарно).
  async function saveMarketplaceEdit(post, editorState) {
    var statusNode = $("#mp-edit-status");
    var room = Math.max(0, 5 - editorState.urls.length);
    var picked = (editorState.files || []).slice(0, room);
    var uploaded = picked.length
      ? await uploadMarketplaceMedia(picked, statusNode)
      : [];
    var payload = {
      post_type: $("#mp-edit-type").value,
      title: String($("#mp-edit-title").value || "").trim(),
      specialization: $("#mp-edit-spec").value,
      city: String($("#mp-edit-city").value || "").trim(),
      volume_desc: String($("#mp-edit-volume").value || "").trim() || null,
      budget_text: String($("#mp-edit-budget").value || "").trim() || null,
      available_from: $("#mp-edit-from").value || null,
      contact_name: String($("#mp-edit-name").value || "").trim(),
      contact_phone: String($("#mp-edit-phone").value || "").trim(),
      media_urls: editorState.urls.concat(uploaded).slice(0, 5),
    };
    if (!payload.title || !payload.city || !payload.contact_name || !payload.contact_phone) {
      toast("Заполните заголовок, город, контакт и телефон");
      return;
    }
    var saveBtn = $("#mp-edit-save");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Сохраняем…"; }
    var res = await sb.from("marketplace_posts").update(payload).eq("id", post.id);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Сохранить"; }
    if (res.error) {
      toast("Не сохранено: " + res.error.message, 8000);
      return;
    }
    // Удалённые автором файлы чистим в бакете (best effort).
    if (editorState.removed && editorState.removed.length) {
      var paths = editorState.removed.map(function (url) {
        var marker = "/marketplace_media/";
        var at = String(url).indexOf(marker);
        return at >= 0 ? decodeURIComponent(String(url).slice(at + marker.length)) : "";
      }).filter(function (path) { return !!path; });
      if (paths.length) {
        try { await sb.storage.from("marketplace_media").remove(paths); } catch (e) { /* best effort */ }
      }
    }
    closeModal();
    toast("Объявление обновлено");
    renderRoute();
  }

  function marketplaceTypeTitle(type) {
    return type === "brigade_available" ? "Бригада ищет объём" : "Ищу подрядчика на объём";
  }



  // ═════════ V192.8 (Спринт 3): Прайсы партнёров (Книга цен) ═════════
  function ratesTabs(active) {
    function btn(code, title) {
      return '<button class="btn ' + (active === code ? "btn-navy" : "btn-outline") +
        ' btn-sm" data-rates-tab="' + code + '" type="button">' + title + "</button>";
    }
    return '<div class="flex mt-8">' +
      btn("base", "Расценки компании") +
      // V193.10: «Прайсы партнёров» — только владелец платформы (суперадминка).
      (state.isSuper ? btn("partner", "Прайсы партнёров (Книга цен)") : "") +
      "</div>";
  }

  function bindRatesTabs(root) {
    $all("[data-rates-tab]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.ratesTab = btn.getAttribute("data-rates-tab");
        renderRoute();
      });
    });
  }

  async function renderPartnerPrices(root) {
    root.innerHTML = '<div class="muted">Загрузка Книги цен партнёров…</div>';
    if (!(await requireAuth(root))) return;
    var res = await sb.from("supplier_price_items").select("*")
      .order("updated_at", { ascending: false }).limit(500);
    var rows = res.data || [];
    var partnerOrg = false;
    if (state.orgId) {
      var orgRes = await sb.from("organizations").select("is_price_partner")
        .eq("id", state.orgId).maybeSingle();
      partnerOrg = !!(orgRes.data && orgRes.data.is_price_partner);
    }
    var canEdit = state.isSuper || partnerOrg;
    state.partnerItems = rows;

    root.innerHTML = ratesTabs("partner") +
      '<div class="flex-between mt-16"><div><h2 class="section-title" style="margin:0;">Прайсы партнёров · Книга цен</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Цены производителей и баз стройматериалов с городом отгрузки и прямой ' +
      "ссылкой на товар. Движок цен проверяет Книгу ДО веб-поиска и учитывает транспортное плечо.</p></div>" +
      (canEdit ? '<button class="btn btn-navy" id="pp-add" type="button">Добавить позицию</button>' : "") +
      "</div>" +
      (canEdit
        ? '<div class="card mt-16"><h3>Импорт прайса</h3>' +
          '<p class="small muted">CSV/XLSX с колонками: наименование, норматив (марка/класс), единица, цена, город склада, ' +
          "URL товара, поставщик (необязательно), действует до (необязательно).</p>" +
          '<label class="field mt-8"><span>Файл прайса (.csv, .xlsx)</span>' +
          '<input type="file" id="pp-import" accept=".csv,.xlsx,text/csv" /></label>' +
          '<div class="small muted mt-8" id="pp-import-status"></div></div>'
        : '<div class="warn-box mt-16">Загрузка прайсов доступна организациям со статусом «Партнёр Книги цен» ' +
          "и владельцу платформы. Просмотр цен доступен всем.</div>") +
      '<div class="card mt-16"><div class="table-wrap" style="max-height:56vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Материал</th><th>Ед.</th><th class="num">Цена, ₽</th>' +
      "<th>Город склада</th><th>Поставщик</th><th>Обновлено</th><th></th></tr></thead><tbody>" +
      (rows.length ? rows.map(function (row) {
        return "<tr><td><strong>" + esc(row.material_name) + '</strong><div class="small muted">' +
          esc(row.material_norm || "") + "</div></td>" +
          "<td>" + esc(row.unit) + "</td>" +
          '<td class="num">' + money(row.price) + "</td>" +
          "<td>" + esc(row.city) + "</td>" +
          "<td>" + esc(row.supplier_name) + (row.is_verified_partner ? " " + pill("партнёр", "ok") : "") + "</td>" +
          '<td class="small">' + esc(fmtDate(row.updated_at)) + "</td>" +
          "<td>" + (row.product_url
            ? '<a class="btn btn-outline btn-sm" href="' + esc(row.product_url) + '" target="_blank" rel="noopener">Товар</a> '
            : "") +
          (canEdit
            ? '<button class="btn btn-outline btn-sm" data-pp-edit="' + esc(row.id) + '" type="button">Изменить</button> ' +
              '<button class="btn btn-danger btn-sm" data-pp-del="' + esc(row.id) + '" type="button">Удалить</button>'
            : "") + "</td></tr>";
      }).join("") : '<tr><td colspan="7" class="muted">Книга пуста — партнёры ещё не загрузили прайсы.</td></tr>') +
      "</tbody></table></div></div>";

    bindRatesTabs(root);
    var addBtn = $("#pp-add");
    if (addBtn) addBtn.addEventListener("click", function () { openPartnerItemModal(null); });
    function pick(attr) {
      return (state.partnerItems || []).filter(function (row) { return String(row.id) === attr; })[0];
    }
    $all("[data-pp-edit]", root).forEach(function (btn) {
      btn.addEventListener("click", function () { openPartnerItemModal(pick(btn.getAttribute("data-pp-edit"))); });
    });
    $all("[data-pp-del]", root).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var row = pick(btn.getAttribute("data-pp-del"));
        if (!row) return;
        var del = await sb.from("supplier_price_items").delete().eq("id", row.id);
        if (del.error) { toast("Не удалено: " + del.error.message, 7000); return; }
        toast("Позиция прайса удалена");
        renderRoute();
      });
    });
    var importInput = $("#pp-import");
    if (importInput) {
      importInput.addEventListener("change", function () {
        importPartnerItems(importInput.files && importInput.files[0]);
      });
    }
  }

  function openPartnerItemModal(row) {
    var isEdit = !!row;
    openModal(isEdit ? "Позиция прайса" : "Новая позиция прайса",
      '<div class="form-row">' +
      '<label class="field"><span>Наименование материала</span><input type="text" id="pp-name" value="' +
      esc(isEdit ? row.material_name : "") + '" placeholder="Бетон товарный В25 П4" /></label>' +
      '<label class="field"><span>Марка / класс / норматив</span><input type="text" id="pp-norm" value="' +
      esc(isEdit ? row.material_norm : "") + '" placeholder="В25 W6 F150" /></label>' +
      '<label class="field"><span>Единица</span><input type="text" id="pp-unit" value="' +
      esc(isEdit ? row.unit : "") + '" placeholder="м3" /></label>' +
      '<label class="field"><span>Цена, ₽</span><input type="number" step="0.01" id="pp-price" value="' +
      (isEdit ? num(row.price) : 0) + '" /></label>' +
      "</div>" +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Город склада</span><input type="text" id="pp-city" value="' +
      esc(isEdit ? row.city : "") + '" placeholder="Москва" /></label>' +
      '<label class="field"><span>Поставщик</span><input type="text" id="pp-supplier" value="' +
      esc(isEdit ? row.supplier_name : "") + '" placeholder="ООО «Бетон-Строй»" /></label>' +
      '<label class="field"><span>Действует до</span><input type="date" id="pp-valid" value="' +
      esc(isEdit ? String(row.valid_until || "").slice(0, 10) : "") + '" /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Прямая ссылка на товар</span><input type="url" id="pp-url" value="' +
      esc(isEdit ? row.product_url : "") + '" placeholder="https://supplier.ru/product/123" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="pp-save" type="button">Сохранить</button></div>');
    $("#pp-save").addEventListener("click", async function () {
      var payload = {
        supplier_org_id: state.orgId || null,
        supplier_name: String($("#pp-supplier").value || "").trim() || (state.orgName || "Партнёр"),
        city: String($("#pp-city").value || "").trim(),
        material_name: String($("#pp-name").value || "").trim(),
        material_norm: String($("#pp-norm").value || "").trim(),
        unit: String($("#pp-unit").value || "").trim(),
        price: round2($("#pp-price").value),
        product_url: String($("#pp-url").value || "").trim(),
        is_verified_partner: true,
        valid_until: $("#pp-valid").value || null,
        updated_at: new Date().toISOString(),
      };
      if (!payload.material_name || !payload.unit || !payload.city || payload.price <= 0) {
        toast("Заполните наименование, единицу, цену и город склада");
        return;
      }
      if (!payload.product_url) { toast("Нужна прямая ссылка на товар"); return; }
      var res = isEdit
        ? await sb.from("supplier_price_items").update(payload).eq("id", row.id)
        : await sb.from("supplier_price_items").insert(payload);
      if (res.error) { toast("Не сохранено: " + res.error.message, 8000); return; }
      closeModal();
      toast(isEdit ? "Позиция обновлена" : "Позиция добавлена в Книгу цен");
      renderRoute();
    });
  }

  function splitDelimitedLine(line, separator) {
    var cells = [];
    var current = "";
    var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') {
        if (quoted && line.charAt(i + 1) === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === separator && !quoted) {
        cells.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function partnerRowsFromMatrix(matrix) {
    var rows = [];
    if (!matrix.length) return rows;
    var header = matrix[0].map(function (cell) { return String(cell || "").trim().toLowerCase(); });
    var hasHeader = header.some(function (cell) {
      return cell.indexOf("наимен") >= 0 || cell.indexOf("материал") >= 0 || cell === "name";
    });
    var start = hasHeader ? 1 : 0;
    for (var i = start; i < matrix.length; i++) {
      var cells = matrix[i].map(function (cell) { return String(cell == null ? "" : cell).trim(); });
      if (!cells.length || !cells[0]) continue;
      var name = cells[0];
      var norm = cells[1] || "";
      var unit = cells[2] || "";
      var price = num(cells[3]);
      var city = cells[4] || "";
      var url = cells[5] || "";
      var supplier = cells[6] || (state.orgName || "Партнёр");
      var validUntil = cells[7] || null;
      if (!name || !unit || !city || price <= 0) continue;
      rows.push({
        supplier_org_id: state.orgId || null,
        supplier_name: supplier,
        city: city,
        material_name: name,
        material_norm: norm,
        unit: unit,
        price: round2(price),
        product_url: url,
        is_verified_partner: true,
        valid_until: validUntil,
        updated_at: new Date().toISOString(),
      });
    }
    return rows;
  }


  async function unzipEntries(buffer) {
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip_eocd_not_found");
    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);
    var entries = {};
    for (var n = 0; n < count; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      var method = view.getUint16(offset + 10, true);
      var compSize = view.getUint32(offset + 20, true);
      var nameLen = view.getUint16(offset + 28, true);
      var extraLen = view.getUint16(offset + 30, true);
      var commentLen = view.getUint16(offset + 32, true);
      var localOffset = view.getUint32(offset + 42, true);
      var name = new TextDecoder("utf-8").decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
      entries[name] = { method: method, compSize: compSize, localOffset: localOffset };
      offset += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      var entry = entries[name];
      if (!entry) return null;
      var lo = entry.localOffset;
      var localNameLen = view.getUint16(lo + 26, true);
      var localExtraLen = view.getUint16(lo + 28, true);
      var start = lo + 30 + localNameLen + localExtraLen;
      var data = bytes.subarray(start, start + entry.compSize);
      if (entry.method === 0) return new TextDecoder("utf-8").decode(data);
      if (typeof DecompressionStream === "undefined") throw new Error("deflate_not_supported");
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    return { names: Object.keys(entries), read: read };
  }

  function decodeXmlText(value) {
    return String(value || "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  function columnIndex(ref) {
    var letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
    if (!letters) return -1;
    var index = 0;
    for (var i = 0; i < letters.length; i++) {
      index = index * 26 + (letters.charCodeAt(i) - 64);
    }
    return index - 1;
  }

  async function parseXlsxMatrix(buffer) {
    var zip = await unzipEntries(buffer);
    var shared = [];
    var sharedXml = await zip.read("xl/sharedStrings.xml");
    if (sharedXml) {
      shared = sharedXml.split("<si>").slice(1).map(function (chunk) {
        return chunk.split("<t").slice(1).map(function (part) {
          return decodeXmlText((part.split(">")[1] || "").split("</t")[0]);
        }).join("");
      });
    }
    var sheetName = zip.names.filter(function (name) {
      return /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    })[0];
    if (!sheetName) throw new Error("sheet_not_found");
    var sheetXml = await zip.read(sheetName);
    var matrix = [];
    sheetXml.split("<row").slice(1).forEach(function (rowChunk) {
      var cells = [];
      rowChunk.split("<c").slice(1).forEach(function (cellChunk) {
        var refMatch = /r="([A-Z]+\d+)"/.exec(cellChunk);
        var typeMatch = /t="([^"]+)"/.exec(cellChunk.split(">")[0] || "");
        var valueMatch = /<v>([\s\S]*?)<\/v>/.exec(cellChunk);
        var textMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cellChunk);
        var value = textMatch ? decodeXmlText(textMatch[1])
          : (valueMatch ? decodeXmlText(valueMatch[1]) : "");
        if (typeMatch && typeMatch[1] === "s" && value !== "") {
          value = shared[parseInt(value, 10)] || "";
        }
        var index = refMatch ? columnIndex(refMatch[1]) : cells.length;
        if (index < 0) index = cells.length;
        cells[index] = value;
      });
      for (var k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = "";
      matrix.push(cells);
    });
    return matrix;
  }


  async function importPartnerItems(file) {
    if (!file) return;
    var statusNode = $("#pp-import-status");
    if (statusNode) statusNode.textContent = "Читаем файл " + file.name + "…";
    try {
      var matrix;
      if (/\.xlsx$/i.test(file.name)) {
        matrix = await parseXlsxMatrix(await file.arrayBuffer());
      } else {
        var text = await file.text();
        var separator = text.indexOf(";") >= 0 ? ";" : ",";
        matrix = text.split(/\r?\n/)
          .filter(function (line) { return line.trim().length > 0; })
          .map(function (line) { return splitDelimitedLine(line, separator); });
      }
      var rows = partnerRowsFromMatrix(matrix);
      if (!rows.length) {
        if (statusNode) {
          statusNode.textContent = "Валидных строк нет: нужны наименование, единица, цена и город склада.";
        }
        return;
      }
      var ins = await sb.from("supplier_price_items").insert(rows);
      if (ins.error) {
        if (statusNode) statusNode.textContent = "Импорт не выполнен: " + ins.error.message;
        return;
      }
      if (statusNode) statusNode.textContent = "Импортировано позиций: " + rows.length;
      toast("Прайс загружен: " + rows.length + " позиций", 6000);
      renderRoute();
    } catch (err) {
      if (statusNode) {
        statusNode.textContent = "Ошибка импорта: " + (err && err.message ? err.message : err) +
          " · для сложных XLSX сохраните лист как CSV";
      }
    }
  }

  // ═════════ V192.8: партнёр Книги цен и модерация Биржи в админке ═════════
  async function toggleOrgPartner(org) {
    if (!org) return;
    var next = !org.is_price_partner;
    var res = await sb.from("organizations").update({ is_price_partner: next }).eq("id", org.id);
    if (res.error) { toast("Статус партнёра не изменён: " + res.error.message, 7000); return; }
    toast(next ? "Организация — партнёр Книги цен" : "Статус партнёра снят");
    renderRoute();
  }

  function marketplaceModerationHtml(posts) {
    if (!posts || !posts.length) {
      return '<tr><td colspan="6" class="muted">Объявлений пока нет.</td></tr>';
    }
    return posts.map(function (post) {
      return "<tr><td>" + esc(post.title) + "</td>" +
        "<td>" + esc(marketplaceTypeTitle(post.post_type)) + "</td>" +
        "<td>" + esc(post.city || "") + " · " + esc(post.specialization || "") + "</td>" +
        "<td>" + pill(post.status, post.status === "active" ? "ok" : "warn") + "</td>" +
        '<td class="small">' + esc(fmtDate(post.created_at)) + "</td>" +
        '<td><div class="flex">' +
        '<button class="btn btn-outline btn-sm" data-post-status="' + esc(post.id) + '" data-status="active" type="button">Опубликовать</button>' +
        '<button class="btn btn-outline btn-sm" data-post-status="' + esc(post.id) + '" data-status="hidden" type="button">Скрыть</button>' +
        '<button class="btn btn-danger btn-sm" data-post-delete="' + esc(post.id) + '" type="button">Удалить</button>' +
        "</div></td></tr>";
    }).join("");
  }

  async function moderateMarketplacePost(postId, status) {
    var upd = await sb.from("marketplace_posts").update({ status: status }).eq("id", postId);
    if (upd.error) { toast("Модерация не выполнена: " + upd.error.message, 7000); return; }
    toast("Статус объявления: " + status);
    renderRoute();
  }

  // ═════════ V193.2: полноэкранный просмотр фото Биржи (зум + свайп) ═════════
  function openMarketplaceLightbox(urls, initialIndex) {
    var photos = (urls || []).filter(function (url) {
      return url && !isVideoUrl(url);
    });
    if (!photos.length) return;
    var startUrl = (urls || [])[Math.max(0, Math.min(initialIndex || 0, (urls || []).length - 1))];
    var index = Math.max(0, photos.indexOf(startUrl));
    var scale = 1;
    var overlay = document.createElement("div");
    overlay.className = "np-lightbox";
    overlay.innerHTML =
      '<button class="np-lightbox-close" type="button" aria-label="Закрыть">×</button>' +
      '<div class="np-lightbox-stage"><img class="np-lightbox-img" alt="Фото портфолио" /></div>' +
      '<div class="np-lightbox-bar">' +
      '<button type="button" data-lb-prev aria-label="Предыдущее">‹</button>' +
      '<span class="np-lightbox-counter"></span>' +
      '<button type="button" data-lb-next aria-label="Следующее">›</button>' +
      '<button type="button" data-lb-zoom>1:1</button></div>';
    document.body.appendChild(overlay);
    document.body.classList.add("np-lightbox-open");

    var img = overlay.querySelector(".np-lightbox-img");
    var counter = overlay.querySelector(".np-lightbox-counter");

    function paint() {
      img.src = photos[index];
      img.style.transform = "scale(" + scale + ")";
      counter.textContent = (index + 1) + " / " + photos.length;
    }
    function close() {
      document.body.classList.remove("np-lightbox-open");
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") { index = (index - 1 + photos.length) % photos.length; scale = 1; paint(); }
      if (event.key === "ArrowRight") { index = (index + 1) % photos.length; scale = 1; paint(); }
    }
    function toggleZoom(event) {
      if (event) event.stopPropagation();
      scale = scale > 1 ? 1 : 2.2;
      paint();
    }
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay || event.target.classList.contains("np-lightbox-stage")) close();
    });
    overlay.querySelector(".np-lightbox-close").addEventListener("click", close);
    overlay.querySelector("[data-lb-prev]").addEventListener("click", function (event) {
      event.stopPropagation();
      index = (index - 1 + photos.length) % photos.length;
      scale = 1;
      paint();
    });
    overlay.querySelector("[data-lb-next]").addEventListener("click", function (event) {
      event.stopPropagation();
      index = (index + 1) % photos.length;
      scale = 1;
      paint();
    });
    overlay.querySelector("[data-lb-zoom]").addEventListener("click", toggleZoom);
    img.addEventListener("click", toggleZoom);
    img.addEventListener("wheel", function (event) {
      event.preventDefault();
      scale = Math.max(1, Math.min(4, scale + (event.deltaY < 0 ? 0.25 : -0.25)));
      paint();
    }, { passive: false });
    document.addEventListener("keydown", onKey);
    paint();
  }

  // ═════════ V193.0: избранное Биржи, лёгкая лента, удаление пользователей ═════════
  async function loadMarketplaceFavorites() {
    if (!state.userId) return;
    try {
      var res = await sb.from("marketplace_favorites").select("post_id");
      state.favoritePosts = {};
      (res.data || []).forEach(function (row) {
        state.favoritePosts[String(row.post_id)] = true;
      });
    } catch (e) {
      state.favoritePosts = state.favoritePosts || {};
    }
  }

  function isFavoritePost(postId) {
    return !!(state.favoritePosts && state.favoritePosts[String(postId)]);
  }

  async function toggleFavorite(postId) {
    if (!state.userId) { toast("Войдите, чтобы сохранять избранное"); return false; }
    var key = String(postId);
    if (isFavoritePost(key)) {
      var del = await sb.from("marketplace_favorites").delete()
        .eq("post_id", key).eq("user_id", state.userId);
      if (del.error) { toast("Избранное не обновлено: " + del.error.message, 6000); return false; }
      delete state.favoritePosts[key];
      toast("Удалено из избранного");
      return false;
    }
    var ins = await sb.from("marketplace_favorites").insert({
      user_id: state.userId, post_id: key,
    });
    if (ins.error) { toast("Избранное не обновлено: " + ins.error.message, 6000); return false; }
    state.favoritePosts[key] = true;
    toast("Добавлено в избранное ♥");
    return true;
  }

  function favoriteButtonHtml(postId, extraClass) {
    var active = isFavoritePost(postId);
    return '<button class="' + (extraClass || "") + '" data-fav="' + esc(postId) + '" type="button" ' +
      'title="В избранное" style="position:absolute;right:8px;top:8px;width:34px;height:34px;' +
      'border-radius:50%;border:none;cursor:pointer;font-size:16px;' +
      'background:' + (active ? "#FEE2E2" : "rgba(255,255,255,.92)") + ";color:" +
      (active ? "#DC2626" : "#64748B") + ';">' + (active ? "♥" : "♡") + "</button>";
  }

  function postMediaPreviewUrl(post) {
    var media = Array.isArray(post.media_urls) ? post.media_urls : [];
    return media.length ? String(media[0]) : "";
  }

  function isVideoUrl(url) {
    return /\.(mp4|mov|webm|mkv)(\?|$)/i.test(String(url || ""));
  }

  /// V193.1: светлый плейсхолдер вместо чёрного квадрата при обрыве фото.
  var MEDIA_FALLBACK_IMG =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
      '<rect width="100%" height="100%" fill="#E2E8F0"/>' +
      '<text x="50%" y="52%" font-family="Segoe UI,Arial" font-size="13" fill="#64748B" ' +
      'text-anchor="middle">фото недоступно</text></svg>');

  function marketplacePhotoHtml(url, style) {
    return '<img src="' + esc(url) + '" alt="Фото портфолио" loading="lazy" style="' + style + '" ' +
      'onerror="this.onerror=null;this.src=\'' + MEDIA_FALLBACK_IMG + '\';" />';
  }

  /// Карточка-обложка видео: градиент, ▶ Play и подпись «Видео портфолио».
  function marketplaceVideoCoverHtml(height, label) {
    return '<div data-video-cover="1" style="width:100%;height:' + height + 'px;display:grid;' +
      'place-items:center;background:linear-gradient(135deg,#1F497D,#0F172A);color:#BFD3EA;">' +
      '<div style="text-align:center;"><div style="font-size:34px;line-height:1;">▶</div>' +
      '<div style="font-size:11px;font-weight:700;margin-top:4px;">' +
      esc(label || "Видео портфолио") + "</div></div></div>";
  }

  function marketplaceCardsHtml(rows, filters) {
    var city = String((filters || {}).city || "").toLowerCase();
    var spec = String((filters || {}).spec || "");
    var type = String((filters || {}).type || "");
    var onlyFav = !!(filters || {}).onlyFavorites;
    var list = (rows || []).filter(function (row) {
      if (onlyFav && !isFavoritePost(row.id)) return false;
      if (city && String(row.city || "").toLowerCase().indexOf(city) < 0) return false;
      if (spec && String(row.specialization || "") !== spec) return false;
      if (type && String(row.post_type || "") !== type) return false;
      return true;
    });
    if (!list.length) {
      return '<div class="warn-box">' +
        (onlyFav ? "В избранном пока пусто — нажмите ♡ на объявлении." :
          "Объявлений по фильтру нет. Опубликуйте своё — его увидят подрядчики региона.") +
        "</div>";
    }
    return '<div class="grid" style="grid-template-columns:1fr;gap:12px;">' + list.map(function (post) {
      var media = Array.isArray(post.media_urls) ? post.media_urls : [];
      var preview = postMediaPreviewUrl(post);
      var previewHtml = preview
        ? (isVideoUrl(preview)
          ? marketplaceVideoCoverHtml(190, "Видео портфолио")
          : marketplacePhotoHtml(preview, "width:100%;height:100%;object-fit:cover;"))
        : '<div style="width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(135deg,#E2E8F0,#CBD5E1);">' +
          '<span style="font-size:26px;color:#64748B;">🏗</span></div>';
      return '<div class="card" data-post-open="' + esc(post.id) + '" style="cursor:pointer;padding:0;overflow:hidden;">' +
        '<div style="position:relative;height:190px;background:#E2E8F0;">' + previewHtml +
        (media.length > 1
          ? '<span style="position:absolute;left:8px;bottom:8px;background:rgba(15,23,42,.75);color:#fff;' +
            'font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;">1/' + media.length + "</span>"
          : "") +
        favoriteButtonHtml(post.id) +
        "</div>" +
        '<div style="padding:12px 14px 14px;">' +
        '<div class="flex-between" style="align-items:flex-start;">' +
        '<div style="min-width:0;"><div style="font-weight:800;font-size:15.5px;color:#0F172A;">' +
        esc(post.title) + "</div>" +
        (String(post.budget_text || "").trim()
          ? '<div style="font-weight:800;font-size:17px;color:#1F497D;margin-top:2px;">' +
            esc(post.budget_text) + "</div>" : "") +
        "</div>" +
        pill(marketplaceTypeTitleShort(post.post_type),
          post.post_type === "brigade_available" ? "ok" : "info") + "</div>" +
        '<div class="small muted mt-8">' + esc(post.city) + " · " + esc(post.specialization) +
        " · " + esc(fmtDate(post.created_at).slice(0, 10)) + "</div>" +
        (String(post.author_user_id) === String(state.userId)
          ? '<div class="flex mt-8"><button class="btn btn-outline btn-sm" data-post-edit="' +
            esc(post.id) + '" type="button">Редактировать</button></div>'
          : '<div class="flex mt-8"><button class="btn btn-navy btn-sm" data-post-write="' +
            esc(post.id) + '" type="button">Написать по объявлению</button></div>') +
        "</div></div>";
    }).join("") + "</div>";
  }

  async function renderMarketplaceBoard(root) {
    root.innerHTML = '<div class="muted">Загрузка биржи подрядов…</div>';
    await loadMarketplaceFavorites();
    var res = await sb.from("marketplace_posts")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(200);
    if (res.error) {
      root.innerHTML = '<div class="warn-box mt-16">Не удалось прочитать биржу: ' +
        esc(res.error.message) + "</div>";
      return;
    }
    var rows = res.data || [];
    state.marketplacePosts = rows;
    var filters = state.marketplaceFilters || (state.marketplaceFilters = {
      city: "", spec: "", type: "", onlyFavorites: false,
    });
    var specs = {};
    rows.forEach(function (row) { if (row.specialization) specs[row.specialization] = true; });

    root.innerHTML =
      '<div class="flex-between mt-16"><div><h2 class="section-title" style="margin:0;">Биржа подрядов</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Лёгкая лента объявлений: фото портфолио, бюджет и контакты ' +
      "внутри карточки. Личное избранное ♥ сохраняется за вами.</p></div>" +
      '<button class="btn btn-navy" id="post-add" type="button">Опубликовать объявление</button></div>' +
      '<div class="flex mt-16">' +
      '<button class="btn ' + (filters.onlyFavorites ? "btn-outline" : "btn-navy") +
      ' btn-sm" id="mp-all" type="button">Все объявления</button>' +
      '<button class="btn ' + (filters.onlyFavorites ? "btn-navy" : "btn-outline") +
      ' btn-sm" id="mp-fav" type="button">Избранное ♥</button></div>' +
      '<div class="form-row mt-8">' +
      '<label class="field"><span>Город</span><input type="text" id="mp-city" value="' + esc(filters.city) +
      '" placeholder="Москва" /></label>' +
      '<label class="field"><span>Специализация</span><select id="mp-spec"><option value="">Все виды работ</option>' +
      Object.keys(specs).sort().map(function (item) {
        return '<option value="' + esc(item) + '"' + (filters.spec === item ? " selected" : "") + ">" +
          esc(item) + "</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Тип объявления</span><select id="mp-type">' +
      '<option value="">Все типы</option>' +
      '<option value="need_contractor"' + (filters.type === "need_contractor" ? " selected" : "") +
      ">Ищу подрядчика на объём</option>" +
      '<option value="brigade_available"' + (filters.type === "brigade_available" ? " selected" : "") +
      ">Бригада ищет объём</option></select></label></div>" +
      '<div class="mt-16" id="mp-list">' + marketplaceCardsHtml(rows, filters) + "</div>";

    function refresh() {
      $("#mp-list").innerHTML = marketplaceCardsHtml(state.marketplacePosts, filters);
      bindPostActions(root, state.marketplacePosts);
    }
    $("#mp-all").addEventListener("click", function () {
      filters.onlyFavorites = false;
      renderMarketplaceBoard(root);
    });
    $("#mp-fav").addEventListener("click", function () {
      filters.onlyFavorites = true;
      renderMarketplaceBoard(root);
    });
    $("#mp-city").addEventListener("input", function () { filters.city = $("#mp-city").value.trim(); refresh(); });
    $("#mp-spec").addEventListener("change", function () { filters.spec = $("#mp-spec").value; refresh(); });
    $("#mp-type").addEventListener("change", function () { filters.type = $("#mp-type").value; refresh(); });
    $("#post-add").addEventListener("click", openMarketplaceModal);
    bindPostActions(root, state.marketplacePosts);
  }

  function bindPostActions(root, posts) {
    var byId = {};
    (posts || state.marketplacePosts || []).forEach(function (post) { byId[String(post.id)] = post; });
    $all("[data-post-open]", root).forEach(function (card) {
      card.addEventListener("click", function (event) {
        if (event.target && event.target.closest && event.target.closest("button, a")) return;
        openPostDetail(byId[card.getAttribute("data-post-open")]);
      });
    });
    $all("[data-fav]", root).forEach(function (btn) {
      btn.addEventListener("click", async function (event) {
        event.stopPropagation();
        await toggleFavorite(btn.getAttribute("data-fav"));
        renderRoute();
      });
    });
    $all("[data-post-edit]", root).forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        openMarketplaceEditModal(byId[btn.getAttribute("data-post-edit")]);
      });
    });
    // V194.5.5-B: переписка по объявлению (marketplace_messages).
    $all("[data-post-write]", root).forEach(function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        openMarketplaceChat(byId[btn.getAttribute("data-post-write")]);
      });
    });
    bindMaxButtons(root);
  }


  function openPostDetail(post) {
    if (!post) return;
    var mine = String(post.author_user_id) === String(state.userId);
    var media = Array.isArray(post.media_urls) ? post.media_urls : [];
    var slides = media.length ? media.map(function (url, index) {
      return '<div style="min-width:100%;scroll-snap-align:start;height:300px;background:#F8FAFC;' +
        'display:grid;place-items:center;">' +
        (isVideoUrl(url)
          ? '<div data-video-src="' + esc(url) + '" style="width:100%;height:300px;cursor:pointer;">' +
            marketplaceVideoCoverHtml(300, "Видео портфолио · нажмите ▶") + "</div>"
          : '<div data-lb-url="' + esc(url) + '" style="cursor:zoom-in;display:grid;place-items:center;">' +
            marketplacePhotoHtml(url, "max-width:100%;max-height:300px;object-fit:contain;") + "</div>") +
        "</div>";
    }).join("") : '<div style="min-width:100%;height:220px;display:grid;place-items:center;background:#E2E8F0;">' +
      '<span style="font-size:32px;color:#64748B;">🏗</span></div>';

    openModal(post.title || "Объявление",
      '<div style="position:relative;">' +
      '<div id="pd-gallery" style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;border-radius:14px;' +
      'background:#0F172A;">' + slides + "</div>" +
      (media.length > 1
        ? '<span style="position:absolute;left:10px;bottom:10px;background:rgba(15,23,42,.8);color:#fff;' +
          'font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;">1/' + media.length + "</span>"
        : "") +
      favoriteButtonHtml(post.id) + "</div>" +
      '<div class="flex-between mt-16" style="align-items:flex-start;">' +
      '<div><div style="font-weight:800;font-size:18px;color:#0F172A;">' + esc(post.title) + "</div>" +
      (String(post.budget_text || "").trim()
        ? '<div style="font-weight:800;font-size:20px;color:#1F497D;margin-top:2px;">' +
          esc(post.budget_text) + "</div>" : "") + "</div>" +
      pill(marketplaceTypeTitleShort(post.post_type),
        post.post_type === "brigade_available" ? "ok" : "info") + "</div>" +
      '<div class="small muted mt-8">' + esc(post.specialization) + " · " + esc(post.city) +
      (post.available_from ? " · с " + esc(String(post.available_from).slice(0, 10)) : "") +
      " · " + esc(fmtDate(post.created_at).slice(0, 10)) + "</div>" +
      (String(post.volume_desc || "").trim()
        ? '<div class="card mt-16" style="padding:12px;"><strong>Описание и объём работ</strong>' +
          '<p class="small mt-8">' + esc(post.volume_desc) + "</p></div>" : "") +
      '<div class="card mt-16" style="padding:12px;"><strong>Автор объявления</strong>' +
      '<div class="small muted mt-8">' + esc(post.contact_name) + " · " + esc(post.contact_phone) +
      "</div></div>" +
      '<div class="flex mt-16">' +
      '<button class="btn btn-outline btn-sm" id="pd-fav" type="button">' +
      (isFavoritePost(post.id) ? "♥ В избранном" : "♡ В избранное") + "</button>" +
      '<button class="btn btn-outline btn-sm" id="pd-share" type="button">Поделиться</button>' +
      (!mine ? '<button class="btn btn-navy btn-sm" id="pd-write" type="button">' +
        "Написать по объявлению</button>" : "") +
      (mine ? '<button class="btn btn-outline btn-sm" id="detail-edit" type="button">' +
        "Редактировать</button>" : "") +
      (mine ? '<button class="btn btn-outline btn-sm" id="detail-archive" type="button">' +
        "Снять с публикации</button>" : "") +
      (mine || state.isSuper ? '<button class="btn btn-danger btn-sm" id="detail-delete" type="button">' +
        (state.isSuper && !mine ? "Удалить (Админ)" : "Удалить") + "</button>" : "") +
      "</div>" +
      '<div class="card mt-16" style="padding:12px;"><strong>Связаться</strong>' +
      '<div class="flex mt-8">' + contactButtonsHtml(post.contact_phone) + "</div></div>");

    bindMaxButtons($("#modal-body"));
    var pdWrite = $("#pd-write");
    if (pdWrite) pdWrite.addEventListener("click", function () { openMarketplaceChat(post); });
    $all("[data-video-src]", $("#modal-body")).forEach(function (node) {
      node.addEventListener("click", function (event) {
        event.stopPropagation();
        var url = node.getAttribute("data-video-src");
        node.innerHTML = '<video src="' + esc(url) + '" controls autoplay playsinline ' +
          'style="width:100%;height:300px;background:#0F172A;"></video>';
      });
    });
    $all("[data-lb-url]", $("#modal-body")).forEach(function (node) {
      node.addEventListener("click", function (event) {
        event.stopPropagation();
        var url = node.getAttribute("data-lb-url");
        openMarketplaceLightbox(media, media.indexOf(url));
      });
    });
    var editBtn = $("#detail-edit");
    if (editBtn) editBtn.addEventListener("click", function () { openMarketplaceEditModal(post); });
    var favBtn = $("#pd-fav");
    if (favBtn) favBtn.addEventListener("click", async function () {
      await toggleFavorite(post.id);
      openPostDetail(post);
    });
    var shareBtn = $("#pd-share");
    if (shareBtn) shareBtn.addEventListener("click", async function () {
      var link = "https://neyroplan.ru/#/cabinet/contractors";
      try {
        if (navigator.share) {
          await navigator.share({ title: post.title, text: post.title, url: link });
        } else {
          await navigator.clipboard.writeText(post.title + " — " + link);
          toast("Ссылка скопирована");
        }
      } catch (e) { /* пользователь отменил */ }
    });
    var archiveBtn = $("#detail-archive");
    if (archiveBtn) archiveBtn.addEventListener("click", function () { archiveMarketplacePost(post.id); });
    var deleteBtn = $("#detail-delete");
    if (deleteBtn) deleteBtn.addEventListener("click", function () { deleteMarketplacePost(post.id); });
  }


  // ───────── V193.0: компактные карточки бригад + детальный просмотр ─────────
  function contractorRowsHtml(rows, filters) {
    var q = String((filters || {}).q || "");
    var city = String((filters || {}).city || "");
    var list = (rows || []).filter(function (row) {
      if (city && String(row.city || "") !== city) return false;
      if (!q) return true;
      var haystack = [row.full_name, row.specialization, row.city, row.notes].join(" ").toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
    if (!list.length) {
      return '<tr><td colspan="6" class="muted">Пока никого нет — добавьте первого подрядчика.</td></tr>';
    }
    return list.map(function (row) {
      return '<tr data-contractor-open="' + esc(row.id) + '" style="cursor:pointer;">' +
        "<td><strong>" + esc(row.full_name) + "</strong></td>" +
        "<td>" + esc(row.specialization) + "</td>" +
        "<td>" + esc(row.city || "—") + "</td>" +
        "<td>" + starsText(row.rating) + "</td>" +
        '<td class="num">' + (num(row.brigade_size) || 1) + "</td>" +
        '<td><div class="flex">' +
        '<button class="btn btn-outline btn-sm" data-contractor-edit="' + esc(row.id) + '" type="button">Изменить</button>' +
        '<button class="btn btn-danger btn-sm" data-contractor-del="' + esc(row.id) + '" type="button">Удалить</button>' +
        "</div></td></tr>";
    }).join("");
  }

  function openContractorDetail(row) {
    if (!row) return;
    openModal(row.full_name || "Подрядчик",
      '<div class="flex-between"><div><div style="font-weight:800;font-size:17px;">' + esc(row.full_name) + "</div>" +
      '<div class="small muted mt-8">' + esc(row.specialization) + " · " + esc(row.city || "—") +
      " · бригада " + (num(row.brigade_size) || 1) + "</div></div>" + starsText(row.rating) + "</div>" +
      (String(row.notes || "").trim()
        ? '<div class="card mt-16" style="padding:12px;"><strong>Заметки прораба</strong>' +
          '<p class="small mt-8">' + esc(row.notes) + "</p></div>" : "") +
      '<div class="card mt-16" style="padding:12px;"><strong>Связаться</strong>' +
      '<div class="flex mt-8">' + contactButtonsHtml(row.phone) + "</div></div>" +
      '<div class="flex mt-16"><button class="btn btn-outline btn-sm" id="cd-edit" type="button">Изменить</button>' +
      '<button class="btn btn-danger btn-sm" id="cd-del" type="button">Удалить</button></div>');
    bindMaxButtons($("#modal-body"));
    $("#cd-edit").addEventListener("click", function () { closeModal(); openContractorModal(row); });
    $("#cd-del").addEventListener("click", async function () {
      closeModal();
      var del = await sb.from("org_contractors").delete().eq("id", row.id);
      if (del.error) { toast("Не удалось удалить: " + del.error.message, 6000); return; }
      toast("Подрядчик удалён");
      renderRoute();
    });
  }


  // ───────── V193.0: роли, удаление пользователя, отмена расчёта ─────────
  function roleIsRestricted() {
    // V193.1: роли сравниваются по каноническому коду, а не по подстрокам.
    if (state.isSuper) return false;
    var accountType = String((state.profile && state.profile.account_type) || "").toLowerCase();
    if (accountType === "brigadier") return true;
    var code = normalizeRoleCode(state.profile && state.profile.role);
    return code === "FOREMAN" || code === "BRIGADIER" || code === "GUEST";
  }

  function canUseProjectCalc() {
    return state.isSuper || !roleIsRestricted();
  }

  async function assignedProjectIds() {
    if (!state.userId) return [];
    try {
      var res = await sb.from("project_users").select("project_id, auth_id, email")
        .eq("organization_id", state.orgId).limit(200);
      var rows = res.data || [];
      var ids = [];
      rows.forEach(function (row) {
        var authMatch = String(row.auth_id || "") === String(state.userId);
        var emailMatch = String(row.email || "").toLowerCase() ===
          String(state.userEmail || "").toLowerCase();
        if ((authMatch || emailMatch) && row.project_id) ids.push(num(row.project_id));
      });
      return ids;
    } catch (e) {
      return [];
    }
  }

  async function deletePlatformUser(profile) {
    if (!profile || !profile.id) return;
    var email = String(profile.email || "").toLowerCase();
    if (email === "rom61rus@yandex.ru") { toast("Аккаунт владельца удалить нельзя", 6000); return; }
    var confirmed = await new Promise(function (resolve) {
      openModal("Удалить пользователя?",
        '<div class="warn-box">«' + esc(profile.full_name || email || profile.id) +
        "» будет удалён полностью: профиль, доступ в команду, веб-сессии и аккаунт входа. " +
        "Действие необратимо.</div>" +
        '<div class="flex mt-16"><button class="btn btn-danger" id="du-yes" type="button">Удалить</button>' +
        '<button class="btn btn-outline" id="du-no" type="button">Отмена</button></div>');
      $("#du-yes").addEventListener("click", function () { closeModal(); resolve(true); });
      $("#du-no").addEventListener("click", function () { closeModal(); resolve(false); });
    });
    if (!confirmed) return;
    var fn = CFG.registrationFunction || "registration-gateway";
    var res = await sb.functions.invoke(fn, {
      body: { action: "delete_user", user_id: profile.id },
    });
    if (res.error) {
      var detail = "";
      try {
        var ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") {
          var parsed = await ctx.json();
          detail = parsed.message || parsed.error || "";
        }
      } catch (e) { /* без деталей */ }
      toast("Удаление не выполнено: " + (detail || res.error.message), 8000);
      return;
    }
    toast("Пользователь удалён", 5000);
    renderRoute();
  }

  async function cancelProjectCalc(jobId) {
    if (!jobId) return;
    var upd = await sb.from("project_calc_jobs")
      .update({
        status: "cancelled",
        progress_json: { line: "расчёт отменён пользователем", done: 0, total: 0 },
      }).eq("id", jobId);
    if (upd.error) { toast("Не удалось отменить: " + upd.error.message, 7000); return; }
    state.calcJob = Object.assign({}, state.calcJob, {
      status: "cancelled",
      progress_json: { line: "расчёт отменён пользователем", done: 0, total: 0 },
    });
    toast("Расчёт отменён — воркер остановится на ближайшем этапе");
    renderProjectProgress();
  }

  // V193.0: удаление пользователя из таблицы «Пользователи платформы» (делегирование).
  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("[data-user-del]") : null;
    if (!target) return;
    deletePlatformUser({
      id: target.getAttribute("data-user-del"),
      email: target.getAttribute("data-user-email") || "",
      full_name: target.getAttribute("data-user-name") || "",
    });
  });

  // ═════════ V193.10: ОБЪЕКТЫ (обложка в облаке, фотоотчёт, LIVE-камера) ═════════

  var OBJECT_COVER_BUCKET = "object_covers";
  // V194.6.5: обложка по умолчанию, если у объекта нет собственного фото.
  var DEFAULT_OBJECT_COVER = "./assets/default_object_cover.jpg?v=194.6.5";

  /// Список объектов организации (1-в-1 с приложением, без фантомных записей).
  /// V194.5.5-C (ТЗ §1.1): в `public.projects` НЕТ колонки `updated_at` — из
  /// `.select(...)` убраны несуществующие поля (иначе PostgREST отдавал 400 и
  /// блок объектов молча превращался в «Объектов пока нет»). Ошибка запроса
  /// теперь пишется в `console.error` и показывается в самом блоке объектов.
  async function loadProjectsList() {
    state.projects = [];
    state.projectsError = "";
    if (!state.orgId) {
      state.projectsError = "Организация не определена: в профиле не заполнено organization_id.";
      return [];
    }
    var res = await sb.from("projects")
      .select("id, name, city, address, status, camera_stream_url, cover_path, cover_updated_at, " +
        "budget, created_at, " +
        "contract_number, contract_date, investor_name, customer_name, customer_inn, " +
        "contractor_name, contractor_inn, vat_rate")
      .eq("organization_id", state.orgId)
      .order("created_at", { ascending: false });
    if (res.error) {
      state.projectsError = "Объекты не загрузились: " + (res.error.message || res.error);
      console.error("[objects] projects select failed:", res.error, { orgId: state.orgId });
      return [];
    }
    state.projects = res.data || [];
    state.projectsError = "";
    var saved = num(localStorage.getItem("np_active_project") || "0");
    if (saved > 0 && state.projects.some(function (p) { return num(p.id) === saved; })) {
      state.activeProjectId = saved;
    } else {
      state.activeProjectId = state.projects.length ? num(state.projects[0].id) : 0;
      try { localStorage.setItem("np_active_project", String(state.activeProjectId)); } catch (e) {}
    }
    return state.projects;
  }

  function activeProject() {
    var list = Array.isArray(state.projects) ? state.projects : [];
    for (var i = 0; i < list.length; i++) {
      if (num(list[i].id) === num(state.activeProjectId)) return list[i];
    }
    return null;
  }

  function setActiveProject(projectId) {
    state.activeProjectId = num(projectId);
    try { localStorage.setItem("np_active_project", String(state.activeProjectId)); } catch (e) {}
    var project = activeProject();
    if (project) toast("Активный объект: " + (project.name || "объект"));
  }

  /// Публичная ссылка на обложку объекта (бакет object_covers, {org}/{id}.jpg).
  function objectCoverUrl(project) {
    if (!project) return "";
    var path = String(project.cover_path || "").trim();
    if (!path) return "";
    try {
      var res = sb.storage.from(OBJECT_COVER_BUCKET).getPublicUrl(path);
      var url = (res && res.data && res.data.publicUrl) || "";
      if (!url) return "";
      // V194.5.3 (ТЗ §4.1): сброс кэша после замены обложки.
      // V194.5.5-C: реальная колонка `cover_updated_at`, фолбэк — `created_at`
      // (колонки `updated_at` в `public.projects` нет).
      var stamp = project.cover_updated_at || project.created_at || "";
      if (stamp) url += (url.indexOf("?") >= 0 ? "&" : "?") + "v=" + encodeURIComponent(String(stamp));
      return url;
    } catch (e) {
      return "";
    }
  }

  /// V194.6.5: обложка карточки объекта — своё фото, иначе аккуратный фон
  /// по умолчанию (assets/default_object_cover.jpg). Белый текст и кнопки
  /// «Паспорт / Фотоотчёт / Камера» читаются благодаря тёмному градиенту CSS.
  function objectCoverDisplayUrl(project) {
    return objectCoverUrl(project) || DEFAULT_OBJECT_COVER;
  }

  /// Расширение обложки по MIME: ключ в Storage остаётся строго ASCII.
  function objectCoverExtension(file) {
    var type = String((file && file.type) || "").toLowerCase();
    if (type.indexOf("png") >= 0) return "png";
    if (type.indexOf("webp") >= 0) return "webp";
    return "jpg";
  }

  /// ASCII-ключ обложки: «{organization_id}/{project_id}-{timestamp}.{ext}».
  /// Имя загружаемого файла не используется никогда (кириллица в ключе ломает
  /// публичную ссылку), поэтому ключ собирается только из чисел и времени.
  function objectCoverKey(projectId, file) {
    var stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    return String(num(state.orgId)) + "/" + String(num(projectId)) + "-" + stamp +
      "." + objectCoverExtension(file);
  }

  /// Локальный патч обложки: превью и карточка Кабинета обновляются мгновенно.
  function applyProjectCover(projectId, path, stamp) {
    var list = Array.isArray(state.projects) ? state.projects : [];
    for (var i = 0; i < list.length; i++) {
      if (num(list[i].id) === num(projectId)) {
        list[i].cover_path = String(path || "");
        list[i].cover_updated_at = stamp || null;
      }
    }
  }

  /// V194.5.3 (ТЗ §4.1): мягкий сброс обложки объекта.
  async function removeObjectCover(project) {
    if (!project || project.id == null) return;
    var id = num(project.id);
    var path = String(project.cover_path || "").trim();
    try {
      if (path) {
        var del = await sb.storage.from(OBJECT_COVER_BUCKET).remove([path]);
        if (del.error) console.warn("[cover] файл не удалён:", del.error.message);
      }
      // V194.5.5-C2: cover_path объявлена NOT NULL DEFAULT '' — сброс пустой
      // строкой, а не null (иначе PostgREST возвращает 23502/400).
      var stamp = new Date().toISOString();
      var res = await sb.from("projects")
        .update({ cover_path: "", cover_updated_at: stamp })
        .eq("id", id)
        .eq("organization_id", state.orgId);
      if (res.error) throw res.error;
      applyProjectCover(id, "", stamp);
      toast("Обложка сброшена");
      renderRoute();
    } catch (e) {
      toast("Не удалось сбросить обложку: " + ((e && e.message) || e), 7000);
    }
  }

  /// Компактная «пилюля» активного объекта для всех внутренних разделов.
  function objectSwitcherHtml() {
    var project = activeProject();
    var cover = project ? objectCoverDisplayUrl(project) : "";
    var title = project ? (project.name || "Объект без названия") : "Все объекты";
    var sub = project
      ? [project.city, project.address].filter(function (v) { return String(v || "").trim(); }).join(" · ")
      : "выберите объект из списка";
    return '<div class="object-switcher" id="object-switcher" role="button" tabindex="0">' +
      (cover
        ? '<img src="' + esc(cover) + '" alt="" onerror="this.style.display=\'none\'" />'
        : '<span class="os-ph">' + esc((title || "О").slice(0, 1).toUpperCase()) + "</span>") +
      '<span class="os-text"><span class="os-title">' + esc(title) + "</span>" +
      '<span class="os-sub">' + esc(sub || "без адреса") + "</span></span>" +
      '<span class="os-caret">▾</span></div>';
  }

  /// Заполняет слот пилюли (если раздел её предусмотрел).
  function mountObjectSwitcher() {
    var slot = $("#obj-switcher-slot");
    if (!slot) return;
    slot.innerHTML = objectSwitcherHtml();
    var node = $("#object-switcher");
    if (node) node.addEventListener("click", openObjectPicker);
  }

  /// Быстрое переключение активного объекта.
  async function openObjectPicker() {
    if (!(state.projects || []).length) await loadProjectsList();
    var list = state.projects || [];
    var rows = list.map(function (project) {
      var cover = objectCoverDisplayUrl(project);
      var active = num(project.id) === num(state.activeProjectId);
      return '<div class="calc-row mt-8" data-pick="' + esc(project.id) + '">' +
        '<div class="cr-icon"><img src="' + esc(cover) +
        '" style="width:30px;height:30px;border-radius:8px;object-fit:cover;" alt="" /></div>' +
        '<div class="cr-main"><div class="cr-title">' + esc(project.name || "Объект") + "</div>" +
        '<div class="cr-sub">' + esc([project.city, project.address].filter(Boolean).join(" · ") || "адрес не задан") + "</div></div>" +
        '<div class="cr-right">' + (active ? pill("Активный", "ok") : "") + "</div></div>";
    }).join("");
    openModal("Активный объект",
      '<div class="flex" style="justify-content:space-between;align-items:center;">' +
      '<span class="small muted">Переключение влияет на «Финансы», «Штаб стройки» и фотоотчёты.</span>' +
      '<button class="btn btn-navy btn-sm" id="obj-new" type="button">+ Создать объект</button></div>' +
      (rows || '<div class="warn-box mt-16">Объектов пока нет — создайте первый.</div>'));
    var createBtn = $("#obj-new");
    if (createBtn) createBtn.addEventListener("click", function () { openObjectEditor(null); });
    $all("[data-pick]").forEach(function (node) {
      node.addEventListener("click", function () {
        setActiveProject(node.getAttribute("data-pick"));
        closeModal();
        renderRoute();
      });
    });
  }

  /// Вкладка «Объекты»: сетка карточек с обложкой, адресом и действиями.
  async function renderObjects(root) {
    root.innerHTML = '<div class="muted">Загрузка объектов…</div>';
    if (!(await requireAuth(root))) return;
    if (orgMissing()) {
      renderNoOrgMode(root, { title: "Объекты недоступны без организации" });
      return;
    }
    await loadProjectsList();
    var list = state.projects || [];
    var cards = list.map(objectCardHtml).join("");
    root.innerHTML =
      '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Объекты организации</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Паспорт объекта, обложка в общем облаке, ' +
      "фотоотчёт и LIVE-камера — внутри карточки объекта.</p></div>" +
      '<button class="btn btn-navy" id="obj-create" type="button">+ Создать объект</button></div>' +
      '<div id="obj-switcher-slot" class="mt-16"></div>' +
      (cards
        ? '<div class="objects-grid mt-16">' + cards + "</div>"
        : (state.projectsError
          ? '<div class="warn-box mt-16">' + esc(state.projectsError) + "</div>"
          : '<div class="warn-box mt-16">Объектов пока нет. Создайте первый — он появится и на телефоне, ' +
            "и на сайте у всех сотрудников организации.</div>"));
    mountObjectSwitcher();
    var create = $("#obj-create");
    if (create) create.addEventListener("click", function () { openObjectEditor(null); });
    $all("[data-obj-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        location.hash = "#/cabinet/object?id=" + encodeURIComponent(btn.getAttribute("data-obj-open"));
      });
    });
    $all("[data-obj-cover]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        pickObjectCover(btn.getAttribute("data-obj-cover"));
      });
    });
    $all("[data-obj-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var project = (state.projects || []).filter(function (p) {
          return String(p.id) === String(btn.getAttribute("data-obj-edit"));
        })[0];
        openObjectEditor(project || null);
      });
    });
    $all("[data-obj-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteObject(btn.getAttribute("data-obj-del")); });
    });
  }

  function objectCardHtml(project) {
    var cover = objectCoverDisplayUrl(project);
    var camera = String(project.camera_stream_url || "").trim();
    var address = [project.city, project.address].filter(function (v) {
      return String(v || "").trim();
    }).join(", ");
    return '<div class="object-card">' +
      '<div class="oc-cover"><img src="' + esc(cover) + '" alt="" loading="lazy" /></div>' +
      '<div class="oc-body"><div class="oc-title">' + esc(project.name || "Объект") + "</div>" +
      '<div class="oc-sub">' + esc(address || "адрес не задан") + "</div>" +
      '<div class="oc-actions">' +
      (camera ? '<span class="oc-chip">LIVE</span>' : "") +
      '<span class="oc-chip">' + esc(project.status || "в работе") + "</span></div>" +
      '<div class="oc-actions">' +
      '<button class="btn btn-navy btn-sm" data-obj-open="' + esc(project.id) + '" type="button">Открыть</button>' +
      '<button class="btn btn-outline btn-sm" data-obj-cover="' + esc(project.id) + '" type="button">Обложка</button>' +
      '<button class="btn btn-outline btn-sm" data-obj-edit="' + esc(project.id) + '" type="button">Изменить</button>' +
      '<button class="btn btn-outline btn-sm" data-obj-del="' + esc(project.id) + '" type="button">Удалить</button>' +
      "</div></div></div>";
  }

  /// Карточка объекта: паспорт, обложка в облаке, LIVE-камера и фотоотчёт.
  async function renderObjectDetail(root, projectId) {
    root.innerHTML = '<div class="muted">Загрузка объекта…</div>';
    if (!(await requireAuth(root))) return;
    if (orgMissing()) {
      renderNoOrgMode(root, { title: "Паспорт объекта недоступен" });
      return;
    }
    // V194.5.5-C2 (ТЗ §1): любой сбой паспорта показывается блоком с «Повторить»,
    // экран больше не зависает на «Загрузка объекта…».
    try {
      if (!(state.projects || []).length) await loadProjectsList();
      var project = (state.projects || []).filter(function (p) {
        return String(p.id) === String(projectId);
      })[0] || null;
    if (!project) {
      renderFailure(root, "Объект не найден",
        "Объект недоступен этой организации: он удалён либо привязан к другой компании.",
        function () { renderObjectDetail(root, projectId); });
      return;
    }
    setActiveProject(project.id);
    var cover = objectCoverDisplayUrl(project);
    var camera = String(project.camera_stream_url || "").trim();
    var mediaRes = await sb.from("project_media")
      .select("id, project_id, organization_id, file_path, remote_url, media_type, " +
        "stage_name, capture_date, created_at, comment")
      .eq("project_id", num(project.id))
      .eq("organization_id", state.orgId)
      .order("id", { ascending: false }).limit(24);
    if (mediaRes && mediaRes.error) throw mediaRes.error;
    var media = (mediaRes && mediaRes.data) || [];
    var photos = media.filter(function (row) {
      return String(row.media_type || "image").indexOf("video") < 0;
    });
    var gallery = photos.map(function (row, index) {
      var url = String(row.remote_url || "").trim();
      var path = String(row.file_path || "").trim();
      return '<div class="oc-thumb" data-photo="' + index + '" data-path="' + esc(path) + '">' +
        (url ? '<img src="' + esc(url) + '" alt="" />' : '<span class="oc-thumb-ph">📷</span>') +
        '<span class="small muted">' + esc(String(row.capture_date || row.created_at || "").slice(0, 10)) +
        "</span></div>";
    }).join("");
    // V194.5.5-C2: плитки фотоотчёта объявлены явно — раньше переменная
    // `mediaTiles` отсутствовала, ReferenceError оставлял экран на «Загрузка объекта…».
    var mediaTiles = photos.slice(0, 6).map(function (row) {
      var tileUrl = String(row.remote_url || "").trim();
      var tilePath = String(row.file_path || "").trim();
      return '<div class="oc-thumb" data-photo="' + photos.indexOf(row) +
        '" data-path="' + esc(tilePath) + '">' +
        (tileUrl ? '<img src="' + esc(tileUrl) + '" alt="" />' : '<span class="oc-thumb-ph">📷</span>') +
        "</div>";
    }).join("");
    root.innerHTML =
      '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
      '<div><a class="small muted" href="#/cabinet/objects">← Все объекты</a>' +
      '<h2 class="section-title" style="margin:2px 0 0;">' + esc(project.name || "Объект") + "</h2>" +
      '<p class="section-sub" style="margin:4px 0 0;">' +
      esc([project.city, project.address].filter(Boolean).join(", ") || "адрес не задан") + "</p></div>" +
      '<div class="flex"><button class="btn btn-outline btn-sm" id="obj-edit" type="button">Изменить паспорт</button>' +
      '<button class="btn btn-outline btn-sm" id="obj-cover" type="button">Обложка</button></div></div>' +
      '<div id="obj-switcher-slot" class="mt-16"></div>' +
      '<div class="grid grid-2 mt-16">' +
      '<div class="card"><div class="oc-cover oc-cover--detail" id="obj-cover-preview">' +
        '<img src="' + esc(cover) + '" alt="" />' +
        '<div class="oc-cover-actions">' +
        '<button class="btn btn-navy btn-sm" id="obj-cover-replace" type="button">Сменить обложку</button>' +
        '<button class="btn btn-danger btn-sm" id="obj-cover-remove" type="button">Сбросить обложку</button>' +
        "</div></div>" +
      '<p class="small muted mt-8">Обложка 16:9 (JPG/PNG/WebP) хранится в общем облаке организации ' +
      "и сразу обновляется в карточке Кабинета, приложении и на сайте.</p></div>" +
      '<div class="card"><h3 style="margin:0 0 6px;">Паспорт объекта</h3>' +
      passportRow("Статус", project.status) +
      passportRow("Заказчик", project.client) +
      passportRow("Подрядчик", project.contractor) +
      passportRow("Проектировщик", project.designer) +
      passportRow("Технадзор", project.supervision) +
      passportRow("Бюджет", project.budget ? money(project.budget) : "") +
      // V194.1 (ТЗ §1.1): реквизиты договора — шапки КС-2/КС-3 заполняются сами.
      passportRow("Договор подряда", [project.contract_number, project.contract_date]
        .filter(Boolean).join(" от ")) +
      passportRow("Инвестор", project.investor_name) +
      passportRow("Заказчик (юрлицо)", [project.customer_name, project.customer_inn
        ? "ИНН " + project.customer_inn : ""].filter(Boolean).join(", ")) +
      passportRow("Подрядчик (юрлицо)", [project.contractor_name, project.contractor_inn
        ? "ИНН " + project.contractor_inn : ""].filter(Boolean).join(", ")) +
      passportRow("Ставка НДС актов", project.vat_rate == null ? "" :
        String(project.vat_rate) + "%") +
      "</div></div>" +
      '<div class="grid grid-2 mt-16">' +
      '<div class="card"><div class="flex-between"><h3 style="margin:0;">LIVE-камера объекта</h3>' +
      '<button class="btn btn-outline btn-sm" id="obj-camera" type="button">' +
      (camera ? "Изменить ссылку" : "Добавить камеру") + "</button></div>" +
      (camera ? cameraBlock(camera) :
        '<p class="small muted mt-8">Ссылка на поток не задана. Добавьте её — поток появится и в приложении, ' +
        "и на сайте.</p>") + "</div>" +
      '<div class="card"><div class="flex-between"><h3 style="margin:0;">Фотоотчёт объекта</h3>' +
      '<label class="btn btn-navy btn-sm" for="obj-photo" style="cursor:pointer;">+ Добавить фото / видео</label>' +
      '<input id="obj-photo" type="file" accept="image/*,video/*" class="hidden" multiple /></div>' +
      (mediaTiles
        ? '<div class="oc-media-grid">' + mediaTiles + "</div>" +
          (media.length > 6
            ? '<div class="mt-8"><button class="btn btn-outline btn-sm" id="obj-photos-all" type="button">' +
              "Показать все " + media.length + " фото</button></div>"
            : "")
        : '<p class="small muted mt-8">Фотографий пока нет — добавьте первые кадры с площадки.</p>') +
      "</div></div>" +
      // V194.5.5-C2 (ТЗ §2): опасная зона Паспорта — только владелец/директор.
      (canManageOrg()
        ? '<div class="card danger-zone mt-16"><h3 style="margin:0 0 6px;">Опасная зона</h3>' +
          '<p class="small muted">Удаление объекта необратимо: паспорт, фотоотчёт и обложка исчезнут ' +
          "у всех сотрудников организации и в мобильном приложении. Сметы и расчёты остаются " +
          "в архиве организации.</p>" +
          '<button class="btn btn-danger" id="obj-delete" type="button">Удалить объект</button></div>'
        : "");
    mountObjectSwitcher();
    var editBtn = $("#obj-edit");
    if (editBtn) editBtn.addEventListener("click", function () { openObjectEditor(project); });
    var coverBtn = $("#obj-cover");
    if (coverBtn) coverBtn.addEventListener("click", function () { pickObjectCover(project.id); });
    // V194.5.3 (ТЗ §4.1): замена и мягкое удаление обложки прямо в карточке.
    var replaceCoverBtn = $("#obj-cover-replace");
    if (replaceCoverBtn) replaceCoverBtn.addEventListener("click", function () { pickObjectCover(project.id); });
    var removeCoverBtn = $("#obj-cover-remove");
    if (removeCoverBtn) removeCoverBtn.addEventListener("click", function () { removeObjectCover(project); });
    // V194.5.5-C2 (ТЗ §2): удаление объекта из Паспорта (владелец/директор).
    var objDeleteBtn = $("#obj-delete");
    if (objDeleteBtn) objDeleteBtn.addEventListener("click", function () { deleteObject(project.id); });
    var camBtn = $("#obj-camera");
    if (camBtn) camBtn.addEventListener("click", function () { openObjectEditor(project, true); });
    var photoInput = $("#obj-photo");
    if (photoInput) {
      photoInput.addEventListener("change", function (event) {
        uploadObjectPhotos(project, event.target.files);
        event.target.value = "";
      });
    }
    $all("[data-photo]").forEach(function (node) {
      node.addEventListener("click", function () { openObjectPhoto(node.getAttribute("data-path")); });
    });
    // V194.5.3 (ТЗ §4.2): все медиа объекта одной лентой.
    var allPhotosBtn = $("#obj-photos-all");
    if (allPhotosBtn) {
      allPhotosBtn.addEventListener("click", function () {
        openModal("Фотоотчёт объекта · " + media.length,
          '<div class="objects-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));">' +
          gallery + "</div>");
        $all("[data-photo]").forEach(function (node) {
          node.addEventListener("click", function () { openObjectPhoto(node.getAttribute("data-path")); });
        });
      });
    }
    } catch (err) {
      console.error("[object] паспорт не загрузился:", err);
      var reason = (err && err.message) ? err.message : String(err);
      renderFailure(root, "Паспорт объекта не загрузился",
        reason + ". Проверьте соединение и повторите — данные объекта не изменены.",
        function () { renderObjectDetail(root, projectId); });
    }
  }

  function passportRow(label, value) {
    var text = String(value == null ? "" : value).trim();
    return '<div class="rights-row"><span class="muted">' + esc(label) + "</span><span>" +
      esc(text || "—") + "</span></div>";
  }

  function cameraBlock(url) {
    var lower = url.toLowerCase();
    var body = lower.indexOf(".mp4") >= 0
      ? '<video src="' + esc(url) + '" controls playsinline style="width:100%;border-radius:12px;"></video>'
      : '<iframe src="' + esc(url) + '" allow="autoplay; fullscreen" ' +
        'style="width:100%;height:46vh;border:0;border-radius:12px;background:#0F172A;"></iframe>';
    return '<div class="mt-8">' + body +
      '<p class="small muted mt-8">Ссылка: ' + esc(url) + "</p></div>";
  }

  async function openObjectPhoto(path) {
    if (!path) { toast("У фото нет файла в облаке"); return; }
    var signed = await sb.storage.from("project_media").createSignedUrl(path, 3600);
    if (signed.error) { toast("Не удалось открыть фото: " + signed.error.message); return; }
    openModal("Фото объекта",
      '<img src="' + esc(signed.data.signedUrl) + '" alt="" style="width:100%;border-radius:12px;" />');
  }

  /// Паспорт объекта: создание и редактирование (камера — отдельным акцентом).
  function openObjectEditor(project, focusCamera) {
    var isEdit = !!project;
    var data = project || {};
    openModal(isEdit ? "Паспорт объекта" : "Новый объект",
      '<label class="field"><span>Название объекта</span>' +
      '<input type="text" id="ob-name" value="' + esc(data.name || "") + '" placeholder="ЖК «Северный», секция 1" /></label>' +
      '<div class="grid grid-2 mt-8">' +
      '<label class="field"><span>Город</span><input type="text" id="ob-city" value="' + esc(data.city || "") + '" /></label>' +
      '<label class="field"><span>Адрес</span><input type="text" id="ob-address" value="' + esc(data.address || "") + '" /></label>' +
      '<label class="field"><span>Заказчик</span><input type="text" id="ob-client" value="' + esc(data.client || "") + '" /></label>' +
      '<label class="field"><span>Подрядчик</span><input type="text" id="ob-contractor" value="' + esc(data.contractor || "") + '" /></label>' +
      '<label class="field"><span>Бюджет, ₽</span><input type="number" step="0.01" id="ob-budget" value="' + (num(data.budget) || 0) + '" /></label>' +
      '<label class="field"><span>Статус</span><input type="text" id="ob-status" value="' + esc(data.status || "в работе") + '" /></label>' +
      "</div>" +
      '<label class="field"><span>Ссылка на LIVE-камеру (HLS/MP4/iframe)</span>' +
      '<input type="text" id="ob-camera" value="' + esc(data.camera_stream_url || "") + '" placeholder="https://…" /></label>' +
      // V194.1 (ТЗ §1.1): реквизиты договора для шапок КС-2 / КС-3.
      '<h4 class="mt-16" style="margin-bottom:6px;font-size:13px;">Договор и стороны (КС-2 / КС-3)</h4>' +
      '<div class="grid grid-2 mt-8">' +
      '<label class="field"><span>Договор подряда №</span><input type="text" id="ob-contract-number" value="' +
      esc(data.contract_number || "") + '" placeholder="14/2026" /></label>' +
      '<label class="field"><span>Дата договора</span><input type="date" id="ob-contract-date" value="' +
      esc((data.contract_date || "").toString().slice(0, 10)) + '" /></label>' +
      '<label class="field"><span>Инвестор</span><input type="text" id="ob-investor" value="' +
      esc(data.investor_name || "") + '" /></label>' +
      '<label class="field"><span>Ставка НДС актов, %</span><select id="ob-vat">' +
      [0, 5, 7, 20, 22].map(function (rate) {
        var current = data.vat_rate == null ? 22 : num(data.vat_rate);
        return '<option value="' + rate + '"' +
          (current === rate ? " selected" : "") + ">" + rate + "%</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Заказчик (юрлицо)</span><input type="text" id="ob-customer-name" value="' +
      esc(data.customer_name || "") + '" /></label>' +
      '<label class="field"><span>ИНН заказчика</span><input type="text" id="ob-customer-inn" value="' +
      esc(data.customer_inn || "") + '" /></label>' +
      '<label class="field"><span>Подрядчик (юрлицо)</span><input type="text" id="ob-contractor-name" value="' +
      esc(data.contractor_name || "") + '" /></label>' +
      '<label class="field"><span>ИНН подрядчика</span><input type="text" id="ob-contractor-inn" value="' +
      esc(data.contractor_inn || "") + '" /></label>' +
      "</div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="ob-save" type="button">' +
      (isEdit ? "Сохранить" : "Создать объект") + "</button>" +
      (isEdit ? '<span class="small muted">Объект синхронизируется с приложением</span>' : "") + "</div>");
    var nameField = $("#ob-name");
    if (nameField && (focusCamera || !isEdit)) {
      (focusCamera ? $("#ob-camera") : nameField).focus();
    }
    $("#ob-save").addEventListener("click", async function () {
      var payload = {
        name: String($("#ob-name").value || "").trim(),
        city: String($("#ob-city").value || "").trim(),
        address: String($("#ob-address").value || "").trim(),
        client: String($("#ob-client").value || "").trim(),
        contractor: String($("#ob-contractor").value || "").trim(),
        budget: num($("#ob-budget").value),
        status: String($("#ob-status").value || "").trim() || "в работе",
        camera_stream_url: String($("#ob-camera").value || "").trim(),
        // V194.1 (ТЗ §1.1): реквизиты договора для КС-2/КС-3.
        contract_number: String($("#ob-contract-number").value || "").trim(),
        contract_date: String($("#ob-contract-date").value || "").trim() || null,
        investor_name: String($("#ob-investor").value || "").trim(),
        customer_name: String($("#ob-customer-name").value || "").trim(),
        customer_inn: String($("#ob-customer-inn").value || "").replace(/\D+/g, ""),
        contractor_name: String($("#ob-contractor-name").value || "").trim(),
        contractor_inn: String($("#ob-contractor-inn").value || "").replace(/\D+/g, ""),
        vat_rate: num($("#ob-vat").value),
        organization_id: state.orgId,
      };
      if (!payload.name) { toast("Укажите название объекта"); return; }
      var res = isEdit
        ? await sb.from("projects").update(payload).eq("id", num(project.id))
        : await sb.from("projects").insert(payload).select("id").maybeSingle();
      if (res.error) { toast("Не удалось сохранить объект: " + res.error.message, 7000); return; }
      closeModal();
      await loadProjectsList();
      if (!isEdit && res.data && res.data.id) setActiveProject(res.data.id);
      toast(isEdit ? "Паспорт объекта сохранён" : "Объект создан");
      renderRoute();
    });
  }

  /// Выбор и загрузка общей обложки объекта в бакет object_covers.
  function pickObjectCover(projectId) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (file) uploadObjectCover(projectId, file);
    });
    input.click();
  }

  /// V194.5.5-C2 (ТЗ §2): загрузка обложки JPG/PNG/WebP со строго ASCII-ключом.
  async function uploadObjectCover(projectId, file) {
    var id = num(projectId);
    if (!id || !state.orgId) { toast("Объект или организация не определены"); return; }
    if (!file) return;
    var name = String(file.name || "").toLowerCase();
    var type = String(file.type || "").toLowerCase();
    var allowed = type.indexOf("image/jpeg") >= 0 || type.indexOf("image/png") >= 0 ||
      type.indexOf("image/webp") >= 0 || /\.(jpe?g|png|webp)$/.test(name);
    if (!allowed) { toast("Обложка — только JPG, PNG или WebP", 6000); return; }
    var key = objectCoverKey(id, file);
    if (!/^[\x20-\x7E]+$/.test(key)) { toast("Ключ файла обложки должен быть ASCII"); return; }
    var previous = "";
    (state.projects || []).forEach(function (row) {
      if (num(row.id) === id) previous = String(row.cover_path || "").trim();
    });
    toast("Загружаем обложку…");
    try {
      var up = await sb.storage.from(OBJECT_COVER_BUCKET)
        .upload(key, file, {
          upsert: true,
          contentType: file.type || "image/jpeg",
          cacheControl: "0",
        });
      if (up.error) throw up.error;
      var stamp = new Date().toISOString();
      var upd = await sb.from("projects")
        .update({ cover_path: key, cover_updated_at: stamp })
        .eq("id", id)
        .eq("organization_id", state.orgId)
        .select("id");
      if (upd.error) throw upd.error;
      if (!(upd.data || []).length) {
        throw new Error("путь обложки не сохранён: нет прав на объект");
      }
      // Мгновенное обновление превью и карточки Кабинета без ожидания сети.
      applyProjectCover(id, key, stamp);
      renderRoute();
      toast("Обложка обновлена — её видят все сотрудники организации");
      if (previous && previous !== key) {
        try { await sb.storage.from(OBJECT_COVER_BUCKET).remove([previous]); } catch (e2) {}
      }
    } catch (e) {
      toast("Ошибка загрузки обложки: " + ((e && e.message) || e), 7000);
    }
  }

  /// Фотографии объекта: Storage project_media + запись в project_media.
  async function uploadObjectPhotos(project, files) {
    if (!project || !files || !files.length) return;
    var total = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var path = state.orgId + "/" + num(project.id) + "/" + Date.now() + "_" + i + ".jpg";
      try {
        var up = await sb.storage.from("project_media")
          .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
        if (up.error) { toast("Фото не загружено: " + up.error.message, 7000); continue; }
        var ins = await sb.from("project_media").insert({
          project_id: num(project.id),
          organization_id: state.orgId,
          file_path: path,
          media_type: "image",
          stage_name: "",
          capture_date: new Date().toISOString().slice(0, 10),
          author_name: (state.profile && (state.profile.full_name || state.profile.name)) || "",
          author_id: state.userId || null,
          comment: "",
        });
        if (ins.error) { toast("Запись фото не сохранена: " + ins.error.message, 7000); continue; }
        total++;
      } catch (e) {
        toast("Ошибка загрузки фото: " + e, 7000);
      }
    }
    if (total) {
      toast("Фотоотчёт объекта пополнен: " + total);
      renderRoute();
    }
  }

  /// V194.5.5-C2 (ТЗ §2): удаление объекта из Паспорта с подтверждением.
  /// Доступно владельцу платформы и директору организации (RLS projects_delete_org).
  function deleteObject(projectId) {
    var id = num(projectId);
    if (!id) return;
    if (!canManageOrg()) {
      toast("Удалить объект может только владелец или директор организации");
      return;
    }
    var project = (state.projects || []).filter(function (row) {
      return num(row.id) === id;
    })[0] || null;
    var expected = String((project && project.name) || "").trim();
    openModal("Удаление объекта",
      '<p class="small">Объект «' + esc(expected || "без названия") + '» и его фотоотчёт исчезнут ' +
      "у всех сотрудников организации и в мобильном приложении. Сметы и расчёты остаются в архиве.</p>" +
      '<label class="field mt-8"><span>Введите название объекта для подтверждения</span>' +
      '<input type="text" id="del-object-name" autocomplete="off" placeholder="' +
      esc(expected) + '" /></label>' +
      '<div class="small" id="del-object-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="mt-16 flex"><button class="btn btn-danger" id="del-object-submit" type="button">' +
      "Удалить объект</button>" +
      '<button class="btn btn-outline" id="del-object-cancel" type="button">Отмена</button></div>');
    var cancel = $("#del-object-cancel");
    if (cancel) cancel.addEventListener("click", closeModal);
    var field = $("#del-object-name");
    if (field) field.focus();
    var submit = $("#del-object-submit");
    if (submit) {
      submit.addEventListener("click", function () {
        var typed = String(($("#del-object-name") || {}).value || "").trim();
        var errorNode = $("#del-object-error");
        if (expected && typed.toLowerCase() !== expected.toLowerCase()) {
          if (errorNode) errorNode.textContent = "Название не совпадает — объект не удалён";
          return;
        }
        deleteProjectObject(id, project);
      });
    }
  }

  /// Каскадное удаление: фотоотчёт и файлы → запись объекта. FK/RLS объясняются словами.
  async function deleteProjectObject(id, project) {
    var btn = $("#del-object-submit");
    var errorNode = $("#del-object-error");
    if (btn) { btn.disabled = true; btn.textContent = "Удаляем…"; }
    if (errorNode) errorNode.textContent = "";
    try {
      var mediaRes = await sb.from("project_media")
        .select("id, file_path")
        .eq("project_id", id)
        .eq("organization_id", state.orgId)
        .limit(1000);
      if (mediaRes.error) throw mediaRes.error;
      var media = mediaRes.data || [];
      if (media.length) {
        var mediaDel = await sb.from("project_media").delete()
          .eq("project_id", id)
          .eq("organization_id", state.orgId);
        if (mediaDel.error) throw mediaDel.error;
        var paths = media.map(function (row) {
          return String(row.file_path || "").trim();
        }).filter(Boolean);
        if (paths.length) {
          try { await sb.storage.from("project_media").remove(paths); } catch (e2) {}
        }
      }
      var del = await sb.from("projects").delete()
        .eq("id", id)
        .eq("organization_id", state.orgId)
        .select("id");
      if (del.error) throw del.error;
      if (!(del.data || []).length) {
        throw new Error("нет прав на удаление или объект уже удалён");
      }
      var coverPath = String((project && project.cover_path) || "").trim();
      if (coverPath) {
        try { await sb.storage.from(OBJECT_COVER_BUCKET).remove([coverPath]); } catch (e3) {}
      }
      state.projects = (state.projects || []).filter(function (row) {
        return num(row.id) !== id;
      });
      if (num(state.activeProjectId) === id) {
        state.activeProjectId = state.projects.length ? num(state.projects[0].id) : 0;
        try { localStorage.setItem("np_active_project", String(state.activeProjectId)); } catch (e4) {}
      }
      closeModal();
      toast("Объект удалён");
      try { await loadProjectsList(); } catch (e5) { /* список обновит Кабинет */ }
      location.hash = "#/cabinet";
      renderRoute();
    } catch (e) {
      var text = String((e && e.message) || e);
      var hint = text;
      if ((e && e.code === "23503") || text.indexOf("violates foreign key") >= 0) {
        hint = "объект связан с документами организации — сначала удалите сметы, ГПР и акты";
      } else if ((e && e.code === "42501") || text.indexOf("row-level security") >= 0 ||
        text.indexOf("permission") >= 0 || text.indexOf("нет прав") >= 0) {
        hint = "недостаточно прав: удаляет владелец или директор организации";
      }
      var message = "Объект не удалён: " + hint;
      if (errorNode) errorNode.textContent = message;
      else toast(message, 8000);
      if (btn) { btn.disabled = false; btn.textContent = "Удалить объект"; }
    }
  }

  /// Пользовательское соглашение (оферта) и статус расчётов ИИ.
  function renderLegal(root) {
    root.innerHTML =
      '<article class="card legal-body" style="max-width:900px;margin:0 auto;">' +
      "<h2 class=\"section-title\" style=\"margin-top:0;\">Пользовательское соглашение (Оферта)</h2>" +
      '<p class="small muted">Редакция V193.10 · сервис «НейроПлан» (neyroplan.ru)</p>' +
      "<h3>1. Предмет соглашения</h3>" +
      "<p>Сервис предоставляет программные инструменты обработки документов: разбор смет и проектной " +
      "документации, формирование ведомостей объёмов, справочных рыночных цен, себестоимости и " +
      "коммерческих предложений. Сервис не оказывает услуги проектирования, экспертизы или " +
      "сметного нормирования в смысле Градостроительного кодекса РФ.</p>" +
      "<h3>2. Ограничение ответственности и статус расчётов ИИ</h3>" +
      "<p><strong>Все расчёты объёмов, себестоимости, рыночных цен и КП, формируемые сервисом, носят " +
      "исключительно справочно-информационный характер.</strong> Они не являются проектной или " +
      "сметной экспертизой, не имеют юридической силы и <strong>требуют обязательной проверки " +
      "специалистом ПТО/сметчиком до подписания договоров, актов и иных документов</strong>.</p>" +
      "<p>Правообладатель не несёт ответственности за прямые и косвенные убытки, упущенную выгоду, " +
      "штрафы и иные последствия, возникшие при использовании расчётов без профессиональной проверки, " +
      "а также за решения, принятые на их основе.</p>" +
      "<h3>3. Исходные данные</h3>" +
      "<p>Ответственность за полноту, актуальность и достоверность загружаемых документов несёт " +
      "пользователь. Качество распознавания сканов и чертежей зависит от исходного файла.</p>" +
      "<h3>4. Персональные данные</h3>" +
      "<p>Обработка персональных данных выполняется в объёме, необходимом для работы сервиса, " +
      "в соответствии с 152-ФЗ; анонимная статистика посещений не содержит ФИО и контактов.</p>" +
      "<h3>5. Принятие условий</h3>" +
      '<p>Использование сервиса означает согласие с настоящей Офертой. ' +
      '<a href="#/">Вернуться на главную</a> · <a href="#/cabinet/objects">В кабинет</a></p>' +
      "</article>";
  }

  // ═════════ V194.2 (ТЗ §2): рабочая смета, материалы и «Сверх сметы» ═════════
  // Единый источник — те же таблицы, что у Flutter: work_statement_items,
  // finance_transactions (work_item_id/off_budget_type), material_requests.
  var WS_TABS = [
    { key: "works", label: "Работы" },
    { key: "materials", label: "Материалы" },
    { key: "offbudget", label: "Сверх сметы" },
  ];
  var WS_OFF_LABELS = { consumables: "Расходники / Малоценка", extra_works: "Допработы" };
  var WS_REQ_STATUS = { new: "Новая", in_progress: "В закупке", delivered: "На объекте", cancelled: "Отменена" };

  function wsNum(value) {
    var parsed = Number(String(value == null ? "" : value).replace(",", "."));
    return isFinite(parsed) ? parsed : 0;
  }

  function wsProjectName() {
    var row = (state.projects || []).filter(function (p) {
      return num(p.id) === num(state.activeProjectId);
    })[0];
    return row ? String(row.name || "") : "";
  }

  function wsItems(kind) {
    return (state.wsItems || []).filter(function (item) {
      return String(item.item_type || "work") === kind;
    });
  }

  function wsToBuy(item) {
    var need = wsNum(item.plan_qty) - wsNum(item.purchased_qty);
    return need > 0 ? need : 0;
  }

  async function renderWorks(root) {
    root.innerHTML = '<div class="muted">Загрузка рабочей сметы…</div>';
    if (!(await requireAuth(root))) return;
    if (!(state.projects || []).length) await loadProjectsList();
    if (!state.wsTab) state.wsTab = "works";
    if (!state.wsSelected) state.wsSelected = {};
    if (!state.wsMaterialView) state.wsMaterialView = "sections";
    if (state.wsOffFilter === undefined) state.wsOffFilter = "";
    var projectId = num(state.activeProjectId) || 0;
    if (!projectId) {
      root.innerHTML = '<div class="card"><h3>Объект не выбран</h3>' +
        '<p class="small muted">Выберите объект в разделе «Объекты», чтобы вести рабочую смету.</p></div>';
      return;
    }
    var itemsRes = await sb.from("work_statement_items").select("*")
      .eq("organization_id", state.orgId).eq("project_id", projectId)
      .order("sort_order", { ascending: true }).limit(2000);
    var finRes = await sb.from("finance_transactions").select("*")
      .eq("organization_id", state.orgId).eq("project_id", projectId)
      .order("date", { ascending: false }).limit(1000);
    var reqRes = await sb.from("material_requests").select("*")
      .eq("organization_id", state.orgId).eq("project_id", projectId)
      .order("request_number", { ascending: false }).limit(200);
    state.wsItems = itemsRes.data || [];
    state.wsFin = finRes.data || [];
    state.wsRequests = reqRes.data || [];
    root.innerHTML = objectSectionNav("works") + wsHeaderHtml() + wsTabsHtml() +
      '<div id="ws-body" class="mt-16"></div>';
    $all("[data-ws-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.wsTab = btn.getAttribute("data-ws-tab");
        renderRoute();
      });
    });
    wsRenderBody();
    var reqBtn = $("#ws-requests");
    if (reqBtn) reqBtn.addEventListener("click", wsOpenRequests);
    var offBtn = $("#ws-off-add");
    if (offBtn) offBtn.addEventListener("click", wsOpenOffBudget);
    // V194.5.6-B (ТЗ §1): очистка, применение другой сметы, разворот разделов.
    var applyBtn = $("#ws-apply");
    if (applyBtn) applyBtn.addEventListener("click", wsOpenApplyEstimate);
    var clearBtn = $("#ws-clear");
    if (clearBtn) clearBtn.addEventListener("click", function () { wsClearStatement(false); });
    var expandBtn = $("#ws-expand-all");
    if (expandBtn) {
      expandBtn.addEventListener("click", function () {
        state.wsExpandAll = true;
        wsToggleGroups(true);
      });
    }
    var collapseBtn = $("#ws-collapse-all");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function () {
        state.wsExpandAll = false;
        wsToggleGroups(false);
      });
    }
  }

  /// Свёрнутые по умолчанию разделы: развернуть/свернуть все группы разом.
  function wsToggleGroups(expand) {
    $all("details[data-ws-group]").forEach(function (node) { node.open = !!expand; });
  }

  /// «Очистить смету»: удаление позиций работ/материалов выбранного объекта.
  async function wsClearStatement(silent) {
    var projectId = num(state.activeProjectId);
    if (!state.orgId || !projectId) { toast("Выберите объект"); return false; }
    if (!silent && !window.confirm("Очистить рабочую смету объекта? Позиции работ " +
        "и материалов будут удалены безвозвратно.")) return false;
    var res = await sb.from("work_statement_items").delete()
      .eq("organization_id", state.orgId)
      .eq("project_id", projectId);
    if (res.error) { toast("Не очищено: " + res.error.message, 8000); return false; }
    state.wsSelected = {};
    toast("Рабочая смета очищена");
    if (!silent) renderRoute();
    return true;
  }

  /// «Применить другую смету»: выбор из разобранных смет и расчётов ПД/РД объекта.
  async function wsOpenApplyEstimate() {
    var projectId = num(state.activeProjectId);
    if (!state.orgId || !projectId) { toast("Выберите объект"); return; }
    var jobsRes = await sb.from("estimate_jobs")
      .select("id, source_name, status, contract_total, created_at")
      .eq("organization_id", state.orgId)
      .order("created_at", { ascending: false }).limit(40);
    var calcRes = await sb.from("project_calc_jobs")
      .select("id, project_title, status, created_at")
      .eq("org_id", state.orgId)
      .order("created_at", { ascending: false }).limit(40);
    var jobs = (jobsRes.data || []).filter(function (row) {
      return String(row.status || "") === "done";
    });
    var calcs = (calcRes.data || []).filter(function (row) {
      return String(row.status || "") === "done";
    });
    var rows = "";
    jobs.forEach(function (job) {
      rows += '<div class="calc-row mt-8" data-ws-apply-job="' + esc(job.id) + '">' +
        '<div class="cr-icon">📊</div><div class="cr-main">' +
        '<div class="cr-title">' + esc(job.source_name || "Смета") + "</div>" +
        '<div class="cr-sub">Смета · ' + esc(fmtDate(job.created_at)) + " · " +
        money(job.contract_total) + "</div></div></div>";
    });
    calcs.forEach(function (job) {
      rows += '<div class="calc-row mt-8" data-ws-apply-calc="' + esc(job.id) + '">' +
        '<div class="cr-icon">📐</div><div class="cr-main">' +
        '<div class="cr-title">' + esc(job.project_title || "Расчёт по ПД/РД") + "</div>" +
        '<div class="cr-sub">ПД/РД · ' + esc(fmtDate(job.created_at)) + "</div></div></div>";
    });
    openModal("Применить другую смету",
      '<p class="small muted">Текущие позиции рабочей сметы будут заменены выбранной ' +
      "сметой (работы и материалы объекта).</p>" +
      (rows || '<div class="warn-box mt-16">Разобранных смет и расчётов пока нет.</div>'));
    $all("[data-ws-apply-job]").forEach(function (node) {
      node.addEventListener("click", function () {
        wsApplyEstimate("job", node.getAttribute("data-ws-apply-job"));
      });
    });
    $all("[data-ws-apply-calc]").forEach(function (node) {
      node.addEventListener("click", function () {
        wsApplyEstimate("calc", node.getAttribute("data-ws-apply-calc"));
      });
    });
  }

  /// Импорт позиций выбранной сметы/расчёта в `work_statement_items`.
  async function wsApplyEstimate(source, sourceId) {
    var projectId = num(state.activeProjectId);
    if (!state.orgId || !projectId) { toast("Выберите объект"); return; }
    var items = [];
    try {
      if (source === "job") {
        var jobRes = await sb.from("estimate_jobs").select("id, estimate_id")
          .eq("id", sourceId).maybeSingle();
        var estimateId = jobRes.data && jobRes.data.estimate_id;
        var estRes = await sb.from("estimate_items")
          .select("section, code, name, unit, quantity, price, item_type")
          .eq("estimate_id", estimateId).limit(2000);
        items = (estRes.data || []).map(function (row) {
          return {
            section_name: String(row.section || "").trim() || "Смета",
            item_type: String(row.item_type || "work") === "material" ? "material" : "work",
            code: row.code || null,
            name: String(row.name || "Позиция"),
            unit: String(row.unit || ""),
            plan_qty: num(row.quantity),
            unit_price_cost: num(row.price),
            unit_price_client: num(row.price),
          };
        });
      } else {
        var calcRes = await sb.from("project_calc_jobs").select("volumes_json")
          .eq("id", sourceId).maybeSingle();
        var volumes = (calcRes.data && calcRes.data.volumes_json) || {};
        var atoms = (volumes.atoms || []).concat(volumes.derived || []);
        items = atoms.map(function (row) {
          return {
            section_name: String(row.section || "").trim() || "Расчёт ПД/РД",
            item_type: String(row.kind || "") === "work" ? "work" : "material",
            code: row.code || null,
            name: String(row.title || "Позиция"),
            unit: String(row.unit || ""),
            plan_qty: num(row.qty),
            unit_price_cost: num(row.unit_price),
            unit_price_client: num(row.unit_price),
          };
        });
      }
    } catch (e) {
      toast("Не удалось прочитать источник: " + ((e && e.message) || e), 8000);
      return;
    }
    items = items.filter(function (row) { return row.name && row.plan_qty > 0; });
    if (!items.length) { toast("В выбранной смете нет позиций"); return; }
    if (!(await wsClearStatement(true))) return;
    var pack = items.slice(0, 2000).map(function (row, index) {
      return Object.assign({}, row, {
        organization_id: state.orgId,
        project_id: projectId,
        estimate_id: String(sourceId),
        sort_order: index,
      });
    });
    var added = 0;
    for (var start = 0; start < pack.length; start += 200) {
      var chunk = pack.slice(start, start + 200);
      var ins = await sb.from("work_statement_items").insert(chunk);
      if (ins.error) {
        toast("Импорт прерван: " + ins.error.message, 8000);
        break;
      }
      added += chunk.length;
    }
    closeModal();
    toast("Рабочая смета обновлена: " + added + " позиций");
    renderRoute();
  }

  function wsHeaderHtml() {
    var offTotal = (state.wsFin || []).filter(function (row) {
      return String(row.off_budget_type || "") !== "";
    }).reduce(function (sum, row) { return sum + num(row.amount); }, 0);
    var materials = wsItems("material");
    var toBuyCount = materials.filter(function (m) { return wsToBuy(m) > 0; }).length;
    return '<div class="flex-between" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Рабочая смета</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">' + esc(wsProjectName() || "Объект не выбран") +
      " · работ: " + wsItems("work").length + " · материалов: " + materials.length +
      " · докупить: " + toBuyCount + "</p></div>" +
      '<div class="flex"><button class="btn btn-outline btn-sm" id="ws-requests" type="button">Заявки (' +
      (state.wsRequests || []).length + ")</button>" +
      // V194.5.6-B (ТЗ §1): применение другой сметы, сворачивание разделов и очистка.
      '<button class="btn btn-outline btn-sm" id="ws-apply" type="button">Применить другую смету</button>' +
      '<button class="btn btn-outline btn-sm" id="ws-expand-all" type="button">Развернуть все</button>' +
      '<button class="btn btn-outline btn-sm" id="ws-collapse-all" type="button">Свернуть все</button>' +
      '<button class="btn btn-danger btn-sm" id="ws-clear" type="button">Очистить смету</button>' +
      '<button class="btn btn-navy btn-sm" id="ws-off-add" type="button">+ Расход сверх сметы</button></div></div>' +
      '<div class="grid grid-3 mt-16">' +
      '<div class="card"><div class="small muted">Затраты сверх сметы</div><div style="font-size:18px;font-weight:800;">' +
      money(offTotal) + "</div></div>" +
      '<div class="card"><div class="small muted">Материалов к закупке</div><div style="font-size:18px;font-weight:800;">' +
      toBuyCount + "</div></div>" +
      '<div class="card"><div class="small muted">Заявок в работе</div><div style="font-size:18px;font-weight:800;">' +
      (state.wsRequests || []).filter(function (r) {
        return String(r.status || "new") !== "delivered" && String(r.status || "new") !== "cancelled";
      }).length + "</div></div></div>";
  }

  function wsTabsHtml() {
    return '<div class="mt-16" style="display:flex;gap:8px;flex-wrap:wrap;">' +
      WS_TABS.map(function (tab) {
        var active = state.wsTab === tab.key;
        return '<button class="btn ' + (active ? "btn-navy" : "btn-outline") +
          ' btn-sm" type="button" data-ws-tab="' + tab.key + '">' + esc(tab.label) + "</button>";
      }).join("") + "</div>";
  }

  function wsRenderBody() {
    var box = $("#ws-body");
    if (!box) return;
    if (state.wsTab === "materials") {
      box.innerHTML = wsMaterialsHtml();
      wsBindMaterials();
      return;
    }
    if (state.wsTab === "offbudget") {
      box.innerHTML = wsOffBudgetHtml();
      wsBindOffBudget();
      return;
    }
    box.innerHTML = wsWorksHtml();
  }

  /// V194.6.2 (ТЗ §7.1): составные разделы материалов (`A; B; C`) больше не
  /// плодят десятки групп — все они собраны в одну «Общие материалы».
  var WS_MULTI_MATERIALS_TITLE = "Общие материалы (несколько разделов)";

  function wsSectionParts(value) {
    return String(value || "").split(";").map(function (part) {
      return part.trim();
    }).filter(function (part) { return !!part; });
  }

  function wsMaterialGroupName(item) {
    if (state.wsMaterialView === "flat") return "Все материалы";
    var parts = wsSectionParts(item.section_name);
    if (parts.length > 1) return WS_MULTI_MATERIALS_TITLE;
    return String(item.section_name || "").trim() || "Прочее";
  }

  function wsGroupSort(a, b) {
    if (a === WS_MULTI_MATERIALS_TITLE) return 1;
    if (b === WS_MULTI_MATERIALS_TITLE) return -1;
    return a.localeCompare(b, "ru");
  }

  function wsGroupedHtml(items, type) {
    var groups = {};
    var order = [];
    items.forEach(function (item) {
      var name = type === "material"
        ? wsMaterialGroupName(item)
        : (String(item.section_name || "").trim() || "Прочее");
      if (!groups[name]) { groups[name] = []; order.push(name); }
      groups[name].push(item);
    });
    if (type === "material") order.sort(wsGroupSort);
    return order.map(function (name) {
      var rows = groups[name];
      var total = rows.reduce(function (sum, item) {
        return sum + num(item.plan_qty) * num(item.unit_price_client);
      }, 0);
      var body = type === "material" ? wsMaterialRowsHtml(rows) : wsWorkRowsHtml(rows);
      var open = state.wsExpandAll ? " open" : "";
      return '<details class="ws-group" data-ws-group' + open + ">" +
        '<summary class="ws-acc"><span class="ws-acc-arrow" aria-hidden="true">▸</span>' +
        '<span class="ws-group-title">' + esc(name) + "</span>" +
        '<span class="ws-acc-meta">позиций: ' + rows.length +
        " · итог: " + money(total) + "</span></summary>" +
        '<div class="ws-group-body">' + body + "</div></details>";
    }).join("");
  }

  function wsWorkRowsHtml(works) {
    return '<div class="table-wrap" style="max-height:60vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>№</th><th>Наименование работ</th><th>Ед.</th>' +
      '<th class="num">План</th><th class="num">Выполнено</th><th class="num">Сумма работ, ₽</th>' +
      "</tr></thead><tbody>" + works.map(function (item, index) {
        var done = wsNum(item.completed_qty);
        var price = wsNum(item.unit_price_client);
        return "<tr><td>" + (index + 1) + "</td>" +
          "<td>" + esc(item.name || "") + "</td>" +
          "<td>" + esc(item.unit || "") + "</td>" +
          '<td class="num">' + wsNum(item.plan_qty) + "</td>" +
          '<td class="num">' + done + "</td>" +
          '<td class="num">' + money(done * price) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function wsMaterialRowsHtml(materials) {
    return '<div class="table-wrap" style="max-height:58vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th></th><th>Материал</th><th>Ед.</th>' +
      '<th class="num">План</th><th class="num">Куплено</th><th class="num">Использовано</th>' +
      '<th class="num">Докупить</th><th></th></tr></thead><tbody>' +
      materials.map(function (item) {
        var id = String(item.id);
        var toBuy = wsToBuy(item);
        var checked = state.wsSelected && state.wsSelected[id] != null;
        return '<tr><td><input type="checkbox" data-ws-pick="' + esc(id) + '"' +
          (checked ? " checked" : "") + " /></td>" +
          "<td>" + esc(item.name || "") +
          (wsSectionParts(item.section_name).length > 1
            ? '<div class="ws-sections-note">Разделы: ' +
              esc(wsSectionParts(item.section_name).join("; ")) + "</div>"
            : "") + "</td>" +
          "<td>" + esc(item.unit || "") + "</td>" +
          '<td class="num">' + wsNum(item.plan_qty) + "</td>" +
          '<td class="num">' + wsNum(item.purchased_qty) + "</td>" +
          '<td class="num"><a href="#" data-ws-used="' + esc(id) + '">' +
          wsNum(item.used_qty) + "</a></td>" +
          '<td class="num" style="' + (toBuy > 0 ? "color:#B91C1C;font-weight:700;" : "") +
          '">' + toBuy + "</td>" +
          '<td><button class="btn btn-outline btn-sm" type="button" data-ws-buy="' +
          esc(id) + '">Купить</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  function wsWorksHtml() {
    var works = wsItems("work");
    if (!works.length) {
      return '<div class="card"><p class="small muted">Работы не загружены. ' +
        "Загрузите позиции из сметы в приложении (ГПР — КС-2 / КС-3 → «Рабочая смета»).</p></div>";
    }
    return wsGroupedHtml(works, "work");
  }

  function wsMaterialsHtml() {
    var materials = wsItems("material");
    if (!materials.length) {
      return '<div class="card"><p class="small muted">Материалы не загружены. ' +
        "Импорт позиций из сметы доступен в приложении (Рабочая смета → «Загрузить из сметы / ПД»).</p></div>";
    }
    var selectedCount = Object.keys(state.wsSelected || {}).length;
    var flat = state.wsMaterialView === "flat";
    return '<div class="flex-between mt-8" style="gap:8px;flex-wrap:wrap;">' +
      '<div class="flex" style="gap:6px;align-items:center;">' +
      '<span class="small muted">Вид:</span>' +
      '<button class="btn btn-sm ' + (flat ? "btn-outline" : "btn-navy") +
      '" data-ws-view="sections" type="button">По разделам</button>' +
      '<button class="btn btn-sm ' + (flat ? "btn-navy" : "btn-outline") +
      '" data-ws-view="flat" type="button">Единым списком</button></div>' +
      '<div class="small muted">Отмечено к закупке: ' + selectedCount + "</div>" +
      '<button class="btn btn-navy btn-sm" id="ws-order" type="button"' +
      (selectedCount ? "" : " disabled") + ">Заказать остаток (" + selectedCount + ")</button></div>" +
      '<div class="mt-8">' + wsGroupedHtml(materials, "material") + "</div>";
  }

  // ── обработчики вкладки «Материалы» ──
  function wsBindMaterials() {
    $all("[data-ws-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.wsMaterialView = btn.getAttribute("data-ws-view");
        wsRenderBody();
      });
    });
    $all("[data-ws-pick]").forEach(function (node) {
      node.addEventListener("change", function () {
        var id = node.getAttribute("data-ws-pick");
        var item = wsItemById(id);
        if (!state.wsSelected) state.wsSelected = {};
        if (node.checked) {
          state.wsSelected[id] = item ? wsToBuy(item) : 0;
        } else {
          delete state.wsSelected[id];
        }
        wsRenderBody();
      });
    });
    $all("[data-ws-buy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        wsOpenPurchase(btn.getAttribute("data-ws-buy"));
      });
    });
    $all("[data-ws-used]").forEach(function (node) {
      node.addEventListener("click", function (event) {
        event.preventDefault();
        wsOpenUsed(node.getAttribute("data-ws-used"));
      });
    });
    var orderBtn = $("#ws-order");
    if (orderBtn) orderBtn.addEventListener("click", wsOpenOrder);
  }

  function wsItemById(id) {
    return (state.wsItems || []).filter(function (row) {
      return String(row.id) === String(id);
    })[0] || null;
  }

  function wsOpenUsed(id) {
    var item = wsItemById(id);
    if (!item) return;
    openModal("Использовано · " + (item.name || "материал"),
      '<label class="field"><span>Использовано, ' + esc(item.unit || "") + "</span>" +
      '<input type="number" step="0.001" id="ws-used-qty" value="' + wsNum(item.used_qty) + '" /></label>' +
      '<p class="small muted mt-8">Куплено: ' + wsNum(item.purchased_qty) + " " + esc(item.unit || "") +
      ". Списание не меняет закупки — только фактический расход.</p>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ws-used-save" type="button">Сохранить</button></div>');
    $("#ws-used-save").addEventListener("click", async function () {
      var qty = wsNum($("#ws-used-qty").value);
      var res = await sb.from("work_statement_items").update({ used_qty: qty }).eq("id", id);
      if (res.error) { toast("Не сохранено: " + res.error.message, 6000); return; }
      closeModal();
      toast("Использовано сохранено");
      renderRoute();
    });
  }

  function wsOpenPurchase(id) {
    var item = wsItemById(id);
    if (!item) return;
    var need = wsToBuy(item);
    openModal("Покупка · " + (item.name || "материал"),
      '<div class="grid grid-2 mt-8">' +
      '<label class="field"><span>Количество, ' + esc(item.unit || "") + "</span>" +
      '<input type="number" step="0.001" id="ws-buy-qty" value="' + (need > 0 ? need : 0) + '" /></label>' +
      '<label class="field"><span>Сумма по чеку, ₽</span>' +
      '<input type="number" step="0.01" id="ws-buy-amount" /></label>' +
      '<label class="field"><span>Поставщик</span><input type="text" id="ws-buy-supplier" /></label>' +
      '<label class="field"><span>Дата</span><input type="date" id="ws-buy-date" value="' +
      new Date().toISOString().slice(0, 10) + '" /></label>' +
      "</div>" +
      '<p class="small muted mt-8">Закупка сразу уменьшит «Докупить»: purchased_qty пересчитывает триггер БД.</p>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ws-buy-save" type="button">Сохранить покупку</button></div>');
    $("#ws-buy-save").addEventListener("click", async function () {
      var qty = wsNum($("#ws-buy-qty").value);
      var amount = wsNum($("#ws-buy-amount").value);
      if (qty <= 0 || amount <= 0) { toast("Укажите количество и сумму"); return; }
      var res = await sb.from("finance_transactions").insert({
        organization_id: state.orgId,
        project_id: num(state.activeProjectId),
        date: $("#ws-buy-date").value || new Date().toISOString().slice(0, 10),
        type: "расход",
        category: "Материалы",
        amount: amount,
        counterparty: $("#ws-buy-supplier").value.trim(),
        payment_status: "paid",
        comment: "Покупка материала",
        work_item_id: id,
        material_qty: qty,
        material_unit: item.unit || null,
      });
      if (res.error) { toast("Не сохранено: " + res.error.message, 7000); return; }
      closeModal();
      toast("Покупка сохранена");
      renderRoute();
    });
  }

  // ── заявка «Заказать остаток» ──
  function wsOpenOrder() {
    var ids = Object.keys(state.wsSelected || {});
    var selected = ids.map(wsItemById).filter(Boolean);
    if (!selected.length) { toast("Отметьте материалы галочками"); return; }
    var rows = selected.map(function (item) {
      var id = String(item.id);
      var qty = state.wsSelected[id] || wsToBuy(item);
      return '<tr><td>' + esc(item.name || "") + "</td><td>" + esc(item.unit || "") + "</td>" +
        '<td><input type="number" step="0.001" data-ws-order-qty="' + esc(id) + '" value="' + qty +
        '" style="width:110px;" /></td></tr>';
    }).join("");
    openModal("Заявка на закупку · " + selected.length + " поз.",
      '<div class="table-wrap" style="max-height:40vh;overflow:auto;"><table class="data">' +
      "<thead><tr><th>Материал</th><th>Ед.</th><th class=\"num\">Количество</th></tr></thead><tbody>" +
      rows + "</tbody></table></div>" +
      '<div class="grid grid-2 mt-8">' +
      '<label class="field"><span>Нужно к дате</span><input type="date" id="ws-order-date" value="' +
      new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) + '" /></label>' +
      '<label class="field"><span>Комментарий</span><input type="text" id="ws-order-comment" /></label>' +
      "</div>" +
      '<label class="small muted mt-8" style="display:flex;gap:8px;align-items:center;">' +
      '<input type="checkbox" id="ws-order-chat" checked /> Отправить в Штаб стройки</label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ws-order-save" type="button">Сохранить заявку</button></div>');
    $("#ws-order-save").addEventListener("click", async function () {
      var items = selected.map(function (item) {
        var id = String(item.id);
        var qty = wsNum($('[data-ws-order-qty="' + id + '"]').value);
        return { work_item_id: id, name: item.name || "", unit: item.unit || "", qty: qty, note: "" };
      }).filter(function (item) { return item.qty > 0; });
      if (!items.length) { toast("Укажите количество больше нуля"); return; }
      var maxNumber = (state.wsRequests || []).reduce(function (max, row) {
        return Math.max(max, num(row.request_number));
      }, 0);
      var comment = $("#ws-order-comment").value.trim();
      var neededBy = $("#ws-order-date").value || null;
      var res = await sb.from("material_requests").insert({
        organization_id: state.orgId,
        project_id: num(state.activeProjectId),
        request_number: maxNumber + 1,
        status: "new",
        needed_by_date: neededBy,
        comment: comment,
        items_json: items,
      }).select("id, request_number").maybeSingle();
      if (res.error) { toast("Заявка не сохранена: " + res.error.message, 7000); return; }
      if ($("#ws-order-chat").checked) {
        var lines = ["🧾 Заявка №" + (maxNumber + 1) + " на закупку"];
        if (wsProjectName()) lines.push("Объект: " + wsProjectName());
        if (neededBy) lines.push("Нужно к: " + neededBy);
        lines.push("");
        items.forEach(function (item, index) {
          lines.push((index + 1) + ". " + item.name + " — " + item.qty + " " + item.unit);
        });
        if (comment) { lines.push(""); lines.push("Комментарий: " + comment); }
        try {
          await sb.from("chat_messages").insert({
            organization_id: state.orgId,
            channel: (typeof activeChatChannel === "function" ? activeChatChannel() : wsProjectName()),
            sender_name: (state.profile && (state.profile.full_name || state.profile.role)) || "Рабочая смета",
            sender_role: (state.profile && state.profile.role) || "Прораб",
            message: lines.join("\n"),
            timestamp: new Date().toISOString(),
          });
        } catch (e) { /* чат не критичен для заявки */ }
      }
      state.wsSelected = {};
      closeModal();
      toast("Заявка №" + (maxNumber + 1) + " сохранена");
      renderRoute();
    });
  }

  function wsOpenRequests() {
    var rows = (state.wsRequests || []);
    if (!rows.length) {
      openModal("Заявки на закупку",
        '<p class="small muted">Заявок пока нет. Отметьте материалы на вкладке «Материалы» и нажмите «Заказать остаток».</p>');
      return;
    }
    openModal("Заявки на закупку",
      '<div class="table-wrap" style="max-height:50vh;overflow:auto;"><table class="data">' +
      "<thead><tr><th>№</th><th>Дата</th><th>Позиций</th><th>Нужно к</th><th>Статус</th></tr></thead><tbody>" +
      rows.map(function (row) {
        var items = Array.isArray(row.items_json) ? row.items_json : [];
        var status = String(row.status || "new");
        var options = Object.keys(WS_REQ_STATUS).map(function (key) {
          return '<option value="' + key + '"' + (key === status ? " selected" : "") + ">" +
            esc(WS_REQ_STATUS[key]) + "</option>";
        }).join("");
        return "<tr><td>" + num(row.request_number) + "</td>" +
          "<td>" + esc(String(row.created_at || "").slice(0, 10)) + "</td>" +
          "<td>" + items.length + "</td>" +
          "<td>" + esc(row.needed_by_date || "—") + "</td>" +
          '<td><select data-ws-req="' + esc(row.id) + '">' + options + "</select></td></tr>";
      }).join("") + "</tbody></table></div>");
    $all("[data-ws-req]").forEach(function (select) {
      select.addEventListener("change", async function () {
        var res = await sb.from("material_requests")
          .update({ status: select.value }).eq("id", select.getAttribute("data-ws-req"));
        if (res.error) { toast("Статус не изменён: " + res.error.message, 6000); return; }
        toast("Статус заявки обновлён");
      });
    });
  }

  // ── вкладка «Сверх сметы» ──
  function wsOffBudgetHtml() {
    var rows = (state.wsFin || []).filter(function (row) {
      return String(row.off_budget_type || "") !== "";
    }).filter(function (row) {
      return !state.wsOffFilter || String(row.off_budget_type) === state.wsOffFilter;
    });
    var chips = [{ key: "", label: "Все" },
      { key: "consumables", label: "Расходники / Малоценка" },
      { key: "extra_works", label: "Допработы" }].map(function (chip) {
        var active = String(state.wsOffFilter || "") === chip.key;
        return '<button class="btn ' + (active ? "btn-navy" : "btn-outline") +
          ' btn-sm" type="button" data-ws-off="' + chip.key + '">' + esc(chip.label) + "</button>";
      }).join("");
    if (!rows.length) {
      return '<div class="mt-8" style="display:flex;gap:8px;flex-wrap:wrap;">' + chips + "</div>" +
        '<div class="card mt-16"><p class="small muted">Затрат сверх сметы нет. ' +
        "Добавьте расходники, малоценку или допработы кнопкой «+ Расход сверх сметы».</p></div>";
    }
    return '<div class="mt-8" style="display:flex;gap:8px;flex-wrap:wrap;">' + chips + "</div>" +
      '<div class="table-wrap mt-8" style="max-height:56vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Дата</th><th>Вид затрат</th><th>Контрагент</th>' +
      '<th>Комментарий</th><th class="num">Сумма, ₽</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return "<tr><td>" + esc(row.date || "") + "</td>" +
          "<td>" + esc(WS_OFF_LABELS[row.off_budget_type] || row.off_budget_type) + "</td>" +
          "<td>" + esc(row.counterparty || "—") + "</td>" +
          '<td class="small muted">' + esc(row.comment || "") + "</td>" +
          '<td class="num" style="color:#B91C1C;font-weight:700;">' + money(row.amount) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function wsBindOffBudget() {
    $all("[data-ws-off]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.wsOffFilter = btn.getAttribute("data-ws-off");
        wsRenderBody();
      });
    });
  }

  function wsOpenOffBudget() {
    openModal("Расход сверх сметы",
      '<div class="grid grid-2 mt-8">' +
      '<label class="field"><span>Вид затрат</span><select id="ws-off-type">' +
      '<option value="consumables">Расходники / Малоценка</option>' +
      '<option value="extra_works">Допработы</option></select></label>' +
      '<label class="field"><span>Сумма, ₽</span><input type="number" step="0.01" id="ws-off-amount" /></label>' +
      '<label class="field"><span>Контрагент</span><input type="text" id="ws-off-counterparty" /></label>' +
      '<label class="field"><span>Дата</span><input type="date" id="ws-off-date" value="' +
      new Date().toISOString().slice(0, 10) + '" /></label>' +
      "</div>" +
      '<label class="field mt-8"><span>Комментарий</span><input type="text" id="ws-off-comment" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ws-off-save" type="button">Сохранить</button></div>');
    $("#ws-off-save").addEventListener("click", async function () {
      var amount = wsNum($("#ws-off-amount").value);
      if (amount <= 0) { toast("Укажите сумму больше нуля"); return; }
      var type = $("#ws-off-type").value;
      var res = await sb.from("finance_transactions").insert({
        organization_id: state.orgId,
        project_id: num(state.activeProjectId),
        date: $("#ws-off-date").value || new Date().toISOString().slice(0, 10),
        type: "расход",
        category: WS_OFF_LABELS[type] || type,
        amount: amount,
        counterparty: $("#ws-off-counterparty").value.trim(),
        payment_status: "paid",
        comment: $("#ws-off-comment").value.trim(),
        off_budget_type: type,
      });
      if (res.error) { toast("Не сохранено: " + res.error.message, 7000); return; }
      closeModal();
      toast("Расход сверх сметы сохранён");
      renderRoute();
    });
  }

  /// V194.5.5-C (ТЗ §1.2): текущий путь маршрута без hash/query.
  /// Вызывался в модуле Биржи (`currentPath() !== "/marketplace"`), но нигде не
  /// был объявлен — публикация объявления падала с `ReferenceError`.
  function currentPath() {
    var hash = String(location.hash || "").replace(/^#/, "");
    var path = hash.split("?")[0] || "/";
    if (path.length > 1 && path.charAt(path.length - 1) === "/") {
      path = path.slice(0, -1);
    }
    return path || "/";
  }

  /// V194.5.5-C: нужен ли во внутреннем разделе возврат «← В Кабинет».
  function needsBackBar(path) {
    var value = String(path || "");
    if (value.indexOf("/cabinet/") === 0) return true;
    return value === "/admin";
  }

  /// V194.5.5-C: кнопка «← В Кабинет» после любого рендера раздела.
  /// Функция идемпотентна: если панель уже есть — повторно не вставляется,
  /// поэтому MutationObserver на #app не зацикливается.
  function ensureBackBar() {
    var host = $("#app");
    if (!host) return;
    var existing = $("#np-back-bar");
    if (!needsBackBar(currentPath())) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var bar = document.createElement("div");
    bar.id = "np-back-bar";
    bar.className = "np-back-bar";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-outline btn-sm";
    button.textContent = "← В Кабинет";
    button.addEventListener("click", function () { location.hash = "#/cabinet"; });
    bar.appendChild(button);
    host.insertBefore(bar, host.firstChild);
  }

  var backBarTimer = 0;

  /// V194.5.5-C: отложенная доставка панели возврата (без лишних перерисовок).
  function scheduleBackBar() {
    if (backBarTimer) clearTimeout(backBarTimer);
    backBarTimer = setTimeout(function () {
      backBarTimer = 0;
      ensureBackBar();
    }, 60);
  }

  // ═════════ V194.6.2 (ТЗ §7.4): «Акты КС» на компьютере ═════════
  /// Единая навигация раздела объекта: График ГПР · Рабочая смета · Акты КС.
  function objectSectionNav(active) {
    var items = [
      { key: "gpr", label: "График ГПР", href: "#/cabinet/gpr" },
      { key: "works", label: "Рабочая смета", href: "#/cabinet/works" },
      { key: "acts", label: "Акты КС", href: "#/cabinet/acts" },
    ];
    return '<div class="object-nav">' + items.map(function (item) {
      return '<a class="object-nav-item' + (item.key === active ? " is-active" : "") +
        '" href="' + item.href + '">' + esc(item.label) + "</a>";
    }).join("") + "</div>";
  }

  function engineBaseUrl() {
    return String(CFG.engineHealthUrl || "").replace(/\/health.*$/, "");
  }

  async function renderKsActs(root) {
    root.innerHTML = '<div class="muted">Загрузка актов КС…</div>';
    if (!(await requireAuth(root))) return;
    if (!(state.projects || []).length) await loadProjectsList();
    var project = activeProject();
    if (!project) {
      root.innerHTML = objectSectionNav("acts") +
        '<div class="card mt-16"><h3>Объект не выбран</h3>' +
        '<p class="small muted">Выберите объект в разделе «Объекты», чтобы формировать акты КС-2 и КС-3.</p></div>';
      return;
    }
    var projectId = num(project.id);
    var actsRes = await sb.from("ks_acts")
      .select("id, act_number, act_date, period_from, period_to, contract_number, vat_rate, " +
        "subtotal_amount, vat_amount, total_amount, status, ks2_storage_path, ks3_storage_path")
      .eq("organization_id", state.orgId).eq("project_id", projectId)
      .order("act_number", { ascending: false }).limit(200);
    var worksRes = await sb.from("work_statement_items")
      .select("id, section_name, name, unit, plan_qty, closed_ks_qty, unit_price_client, sort_order")
      .eq("organization_id", state.orgId).eq("project_id", projectId)
      .eq("item_type", "work").order("sort_order", { ascending: true }).limit(2000);
    if (actsRes.error) {
      root.innerHTML = objectSectionNav("acts") +
        '<div class="warn-box mt-16">Акты не загрузились: ' + esc(actsRes.error.message) + "</div>";
      return;
    }
    state.ksActs = actsRes.data || [];
    state.ksWorks = worksRes.error ? [] : (worksRes.data || []);
    var acts = state.ksActs;
    var remaining = state.ksWorks.filter(function (row) {
      return num(row.plan_qty) - num(row.closed_ks_qty) > 0;
    }).length;
    var rowsHtml = acts.length ? acts.map(function (act) {
      var draft = String(act.status || "draft") === "draft";
      return "<tr><td><strong>№ " + esc(String(act.act_number || "")) + "</strong></td>" +
        '<td class="small">' + esc(fmtDate(act.act_date)) + "</td>" +
        '<td class="small">' + esc(fmtDate(act.period_from)) + " — " + esc(fmtDate(act.period_to)) + "</td>" +
        '<td class="num">' + money(act.total_amount) + "</td>" +
        "<td>" + (draft ? pill("Черновик", "warn") : pill("Подписан", "ok")) + "</td>" +
        '<td><div class="flex" style="gap:6px;flex-wrap:wrap;">' +
        '<button class="btn btn-outline btn-sm" data-ks-download="' + esc(act.id) +
        '" data-ks-kind="ks2" type="button">Скачать КС-2 (.xlsx)</button>' +
        '<button class="btn btn-outline btn-sm" data-ks-download="' + esc(act.id) +
        '" data-ks-kind="ks3" type="button">Скачать КС-3 (.xlsx)</button>' +
        '<button class="btn btn-danger btn-sm" data-ks-del="' + esc(act.id) +
        '" type="button">Удалить</button></div></td></tr>';
    }).join("") : '<tr><td colspan="6" class="muted">Актов пока нет — сформируйте первый.</td></tr>';
    root.innerHTML = objectSectionNav("acts") +
      '<div class="flex-between mt-16" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Акты КС-2 / КС-3</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">' + esc(project.name || "объект") +
      " · сформировано актов: " + acts.length + " · работ в остатке: " + remaining + "</p></div>" +
      '<button class="btn btn-navy" id="ks-generate" type="button"' +
      (remaining ? "" : " disabled") + ">Сформировать КС-2 / КС-3</button></div>" +
      '<div class="card mt-16"><div class="table-wrap" style="max-height:58vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>Акт</th><th>Дата</th><th>Период</th>' +
      '<th class="num">Сумма</th><th>Статус</th><th>Действия</th></tr></thead><tbody>' +
      rowsHtml + "</tbody></table></div></div>";
    var genBtn = $("#ks-generate");
    if (genBtn) genBtn.addEventListener("click", openKsGenerateModal);
    $all("[data-ks-download]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        downloadKsFile(btn.getAttribute("data-ks-download"), btn.getAttribute("data-ks-kind"));
      });
    });
    $all("[data-ks-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteKsAct(btn.getAttribute("data-ks-del")); });
    });
  }

  function openKsGenerateModal() {
    var works = (state.ksWorks || []).filter(function (row) {
      return num(row.plan_qty) - num(row.closed_ks_qty) > 0;
    });
    if (!works.length) { toast("В рабочей смете нет незакрытых работ"); return; }
    var today = new Date().toISOString().slice(0, 10);
    var nextNumber = (state.ksActs || []).reduce(function (max, act) {
      return Math.max(max, num(act.act_number));
    }, 0) + 1;
    openModal("Сформировать КС-2 / КС-3",
      '<div class="form-row">' +
      '<label class="field"><span>Номер акта</span><input type="number" id="ks-number" value="' +
      nextNumber + '" /></label>' +
      '<label class="field"><span>Дата акта</span><input type="date" id="ks-date" value="' +
      today + '" /></label>' +
      '<label class="field"><span>Период с</span><input type="date" id="ks-from" value="' +
      today + '" /></label>' +
      '<label class="field"><span>Период по</span><input type="date" id="ks-to" value="' +
      today + '" /></label>' +
      '<label class="field"><span>НДС, %</span><select id="ks-vat">' +
      [0, 5, 7, 10, 22].map(function (rate) {
        return '<option value="' + rate + '"' + (rate === 22 ? " selected" : "") + ">" +
          (rate === 0 ? "Без НДС" : rate + " %") + "</option>";
      }).join("") + "</select></label></div>" +
      '<p class="small muted mt-8">Отметьте работы и фактический объём — связанные материалы ' +
      "попадут в акт автоматически, пропорционально объёму работ.</p>" +
      '<div class="table-wrap" style="max-height:44vh;overflow:auto;"><table class="data">' +
      '<thead><tr><th></th><th>Работа</th><th>Ед.</th><th class="num">Остаток</th>' +
      '<th class="num">В акт</th></tr></thead><tbody>' +
      works.map(function (row) {
        var left = round2(num(row.plan_qty) - num(row.closed_ks_qty));
        return '<tr><td><input type="checkbox" data-ks-pick="' + esc(row.id) + '" /></td>' +
          "<td>" + esc(row.name || "Работа") +
          '<div class="small muted">' + esc(row.section_name || "") + "</div></td>" +
          "<td>" + esc(row.unit || "") + '</td><td class="num">' + left + "</td>" +
          '<td class="num"><input type="number" step="0.001" min="0" style="width:100px;' +
          'text-align:right;" data-ks-qty="' + esc(row.id) + '" value="' + left +
          '" disabled /></td></tr>';
      }).join("") + "</tbody></table></div>" +
      '<div class="small" id="ks-error" style="color:#B91C1C;min-height:18px;"></div>' +
      '<div class="flex mt-8"><button class="btn btn-navy" id="ks-submit" type="button">' +
      "Сформировать</button>" +
      '<button class="btn btn-outline" id="ks-cancel" type="button">Отмена</button></div>');
    $("#ks-cancel").addEventListener("click", closeModal);
    $all("[data-ks-pick]").forEach(function (checkbox) {
      checkbox.addEventListener("change", function () {
        var qty = document.querySelector('[data-ks-qty="' +
          checkbox.getAttribute("data-ks-pick") + '"]');
        if (qty) qty.disabled = !checkbox.checked;
      });
    });
    $("#ks-submit").addEventListener("click", async function () {
      var items = [];
      $all("[data-ks-pick]").forEach(function (checkbox) {
        if (!checkbox.checked) return;
        var id = checkbox.getAttribute("data-ks-pick");
        var qtyInput = document.querySelector('[data-ks-qty="' + id + '"]');
        var qty = num(qtyInput && qtyInput.value);
        if (qty > 0) items.push({ work_item_id: id, qty: qty });
      });
      var errorNode = $("#ks-error");
      if (!items.length) {
        if (errorNode) errorNode.textContent = "Отметьте хотя бы одну работу и объём";
        return;
      }
      var base = engineBaseUrl();
      if (!base) { if (errorNode) errorNode.textContent = "Воркер не настроен"; return; }
      var session = (await sb.auth.getSession()).data.session;
      if (!session) { if (errorNode) errorNode.textContent = "Сессия истекла"; return; }
      var button = $("#ks-submit");
      if (button) { button.disabled = true; button.textContent = "Формируем…"; }
      try {
        var resp = await fetch(base + "/api/ks/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + session.accessToken,
          },
          body: JSON.stringify({
            project_id: num(state.activeProjectId),
            act_number: num($("#ks-number").value) || undefined,
            act_date: $("#ks-date").value,
            period_from: $("#ks-from").value,
            period_to: $("#ks-to").value,
            vat_rate: num($("#ks-vat").value),
            items: items,
            include_linked_materials: true,
          }),
        });
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !data || data.ok !== true) {
          var reason = (data && (data.error || data.detail)) || ("HTTP " + resp.status);
          if (errorNode) errorNode.textContent = "Не сформировано: " + reason;
          return;
        }
        closeModal();
        toast("КС-2 и КС-3 сформированы");
        renderRoute();
      } catch (e) {
        if (errorNode) errorNode.textContent = "Не сформировано: " + ((e && e.message) || e);
      } finally {
        if (button) { button.disabled = false; button.textContent = "Сформировать"; }
      }
    });
  }

  async function downloadKsFile(actId, kind) {
    var act = (state.ksActs || []).filter(function (row) {
      return String(row.id) === String(actId);
    })[0];
    if (!act) return;
    var path = kind === "ks3" ? act.ks3_storage_path : act.ks2_storage_path;
    if (!path) { toast("Файл " + (kind === "ks3" ? "КС-3" : "КС-2") + " не сформирован", 6000); return; }
    var signed = await sb.storage.from("ks_documents").createSignedUrl(path, 3600);
    if (signed.error) {
      toast("Не удалось получить ссылку: " + signed.error.message, 8000);
      return;
    }
    window.open(signed.data.signedUrl, "_blank", "noopener");
  }

  /// Удаление акта через серверный воркер (возврат объёмов в остаток),
  /// с локальным откатом, если воркер недоступен.
  async function deleteKsAct(actId) {
    if (!actId) return;
    if (!window.confirm("Удалить акт КС-2/КС-3? Закрытые объёмы вернутся в остаток " +
        "рабочей сметы. Подписанный акт удалить нельзя.")) return;
    var base = engineBaseUrl();
    var session = (await sb.auth.getSession()).data.session;
    var removed = false;
    if (base && session) {
      try {
        var resp = await fetch(base + "/api/ks/delete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + session.accessToken,
          },
          body: JSON.stringify({ act_id: actId }),
        });
        var data = await resp.json().catch(function () { return {}; });
        if (resp.ok && data && data.ok === true) removed = true;
        else if (data && data.error) toast("Воркер: " + data.error, 8000);
      } catch (e) { /* ниже — локальный откат */ }
    }
    if (!removed) {
      var ok = await rollbackKsActLocally(actId);
      if (!ok) { toast("Не удалось удалить акт — проверьте права доступа", 9000); return; }
    }
    toast("Акт удалён, объёмы возвращены в остаток");
    renderRoute();
  }

  async function rollbackKsActLocally(actId) {
    var actRes = await sb.from("ks_acts").select("id, ks2_storage_path, ks3_storage_path")
      .eq("id", actId).eq("organization_id", state.orgId).maybeSingle();
    if (actRes.error || !actRes.data) return false;
    var itemsRes = await sb.from("ks_act_items").select("work_item_id, qty").eq("act_id", actId);
    var items = itemsRes.data || [];
    for (var i = 0; i < items.length; i++) {
      var workId = items[i].work_item_id;
      if (!workId) continue;
      var workRes = await sb.from("work_statement_items").select("closed_ks_qty")
        .eq("id", workId).maybeSingle();
      var closed = num(workRes.data && workRes.data.closed_ks_qty);
      var next = round2(Math.max(0, closed - num(items[i].qty)));
      await sb.from("work_statement_items").update({ closed_ks_qty: next }).eq("id", workId);
    }
    var paths = [actRes.data.ks2_storage_path, actRes.data.ks3_storage_path]
      .filter(function (path) { return !!path; });
    if (paths.length) {
      try { await sb.storage.from("ks_documents").remove(paths); } catch (e) { /* нет файла */ }
    }
    await sb.from("ks_act_items").delete().eq("act_id", actId);
    var del = await sb.from("ks_acts").delete().eq("id", actId);
    return !del.error;
  }



  function renderRoute() {
    var hash = (location.hash || "#/").replace(/^#/, "");
    var path = hash.split("?")[0];
    var query = hash.split("?")[1] || "";
    var queryId = (query.match(/(?:^|&)id=([^&]+)/) || [])[1] || "";
    var root = $("#app");
    // V193.10: «Для партнёров» и «Регистрация» — только на Главной.
    var isLanding = path === "" || path === "/" || path === "/qr" || path === "/legal";
    $all(".landing-only").forEach(function (node) {
      node.classList.toggle("is-hidden", !isLanding);
    });
    // Живая лента чата подписана только на открытом разделе «Штаб стройки».
    if (state.chatChannel && path !== "/cabinet/chat") {
      try { state.chatChannel.unsubscribe(); } catch (e) {}
      state.chatChannel = null;
    }
    renderSessionBadge();
    // V194.6.3 (доп.): пока пароль не задан — кабинет закрыт, открыт только шаг пароля.
    if (state.pendingReg && path.indexOf("/cabinet") === 0) {
      root.innerHTML = '<div class="card"><h3>Регистрация не завершена</h3>' +
        '<p class="small">Остался один шаг — придумать пароль для аккаунта. ' +
        "После сохранения кабинет откроется автоматически.</p>" +
        '<div class="mt-16 flex">' +
        '<button class="btn btn-navy" id="reg-continue" type="button">Задайте пароль</button>' +
        '<button class="btn btn-outline" id="reg-exit" type="button">Выйти</button></div></div>';
      var continueBtn = $("#reg-continue");
      if (continueBtn) continueBtn.addEventListener("click", function () {
        enforceRegistrationPasswordStep();
      });
      var exitBtn = $("#reg-exit");
      if (exitBtn) exitBtn.addEventListener("click", regLogoutLocked);
      enforceRegistrationPasswordStep();
      return;
    }
    if (path === "" || path === "/") { renderLanding(root); return; }
    // V194.5.5-C2 (ТЗ §3): аккаунт без организации не роняет интерфейс —
    // любой раздел Кабинета подменяется понятным Демо-режимом.
    if (path.indexOf("/cabinet") === 0 && orgMissing()) {
      renderNoOrgMode(root, { title: "Раздел доступен после привязки организации" });
      return;
    }
    if (path === "/legal") { renderLegal(root); return; }
    if (path === "/cabinet") { renderCabinet(root); return; }
    if (path === "/cabinet/estimates") { renderEstimates(root); return; }
    if (path === "/cabinet/gpr") { renderGpr(root); return; }
    if (path === "/cabinet/shifts") { renderShifts(root); return; }
    if (path === "/marketplace") { renderMarketplaceBoard(root); return; }
    if (path === "/cabinet/objects") { renderObjects(root); return; }
    if (path === "/cabinet/drawings") { renderDrawings(root); return; }
    if (path === "/cabinet/object") { renderObjectDetail(root, queryId); return; }
    // Старый адрес фотоотчётов ведёт в карточку объекта (меню обновлено).
    if (path === "/cabinet/photos") { renderObjects(root); return; }
    if (path === "/cabinet/rates") { renderRates(root); return; }
    if (path === "/cabinet/project") {
      // V193.0: «Прораб»/«Бригадир» не видят себестоимость и маржу без разрешения.
      if (!canUseProjectCalc()) {
        root.innerHTML = '<div class="card"><h3>Доступ ограничен</h3>' +
          '<p class="small muted">Модуль «Расчёт объекта по ПД/РД» содержит коммерческую ' +
          'себестоимость и маржу. Доступ открывает директор компании.</p></div>';
        return;
      }
      renderProjectCalc(root);
      return;
    }
    if (path === "/cabinet/finance") { renderFinance(root); return; }
    if (path === "/cabinet/works") { renderWorks(root); return; }
    if (path === "/cabinet/acts") { renderKsActs(root); return; }
    if (path === "/cabinet/team") { renderTeam(root); return; }
    if (path === "/cabinet/chat") { renderSiteChat(root); return; }
    if (path === "/cabinet/org") { renderOrgProfile(root); return; }
    if (path === "/cabinet/contractors") { renderContractors(root); return; }
    if (path === "/admin") { renderAdmin(root); return; }
    if (path === "/qr") { renderLanding(root); openQrLogin(); return; }
    if (path === "/join") {
      var joinCode = (hash.split("?")[1] || "").replace(/^.*code=/, "").split("&")[0];
      renderLanding(root);
      openRegistration("employee", decodeURIComponent(joinCode || ""));
      return;
    }
    renderLanding(root);
  }

  // ═════════ V193.3: анонимная посещаемость (152-ФЗ: только случайный ID) ═════════
  function siteVisitorId() {
    try {
      var key = "np_visitor_id";
      var existing = localStorage.getItem(key);
      if (existing) return existing;
      var value = (window.crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(key, value);
      return value;
    } catch (e) {
      return "";
    }
  }

  /// Один визит за сессию: visitor_id + путь + referrer (никаких ФИО/e-mail).
  async function trackSiteVisit() {
    try {
      if (sessionStorage.getItem("np_visit_sent") === "1") return;
      var visitor = siteVisitorId();
      if (!visitor) return;
      sessionStorage.setItem("np_visit_sent", "1");
      await sb.from("site_visits").insert({
        visitor_id: visitor,
        page_path: String(location.hash || "/").slice(0, 200),
        referrer: String(document.referrer || "").slice(0, 300),
      });
    } catch (e) {
      /* аналитика не должна мешать порталу */
    }
  }

  function init() {
    // V193.3: анонимный счётчик посещаемости (один раз за сессию).
    trackSiteVisit();
    $("#modal-close").addEventListener("click", closeModal);
    $("#modal-backdrop").addEventListener("click", function (event) {
      if (event.target === $("#modal-backdrop")) closeModal();
    });
    $("#btn-login").addEventListener("click", openQrLogin);
    var partnersBtn = $("#btn-partners");
    if (partnersBtn) partnersBtn.addEventListener("click", function () {
      openFeedbackModal("partnership");
    });
    // V194.5.6-C (ТЗ §4): единая кнопка «Связаться с разработчиком».
    var feedbackBtn = $("#btn-feedback");
    if (feedbackBtn) feedbackBtn.addEventListener("click", function () {
      openFeedbackModal("support");
    });
    var regBtn = $("#btn-register");
    if (regBtn) regBtn.addEventListener("click", function () { openRegistration("company_owner"); });
    $("#btn-logout").addEventListener("click", async function () {
      // V192.2 (ТЗ §1): ручной выход останавливает наблюдение и чистит локальный токен.
      stopSessionWatch();
      clearWebSession();
      // V192.6: вместе с сессией снимается и подтверждение доступа суперадмина.
      clearAdminVerified();
      closeAdminVerifyTimers();
      await sb.auth.signOut({ scope: "local" });
      // V194.6.3 (доп.): черновик регистрации не должен достаться другому аккаунту.
      regClearPending();
      if (state.reg) {
        regStopOtpTimer();
        state.reg.locked = false;
      }
      state.reg = null;
      state.profile = null;
      state.userId = null;
      state.userEmail = "";
      state.orgName = "";
      state.isSuper = false;
      state.pendingReg = false;
      state.legalV2 = null;
      renderSessionBadge();
      toast("Вы вышли из кабинета");
      location.hash = "#/";
    });
    var releaseNode = $("#release-tag");
    if (releaseNode) releaseNode.textContent = "Релиз " + (CFG.release || "");
    // V194.6.1 (ТЗ §1): верхние кнопки шапки «Тарифы» и «Обучение»
    // (десктоп — в topnav, телефон — в topbar-actions, topnav там скрыт).
    [["nav-tariffs", openTariffsModal], ["nav-tariffs-mobile", openTariffsModal],
     ["nav-learn", openLearningModal], ["nav-learn-mobile", openLearningModal]]
      .forEach(function (pair) {
        var node = $("#" + pair[0]);
        if (node) node.addEventListener("click", pair[1]);
      });

    sb.auth.onAuthStateChange(function () { setTimeout(loadSession, 0); });
    window.addEventListener("hashchange", function () {
      renderRoute();
      scheduleBackBar();
    });
    // V194.5.5-web: кнопка «← В Кабинет» доставляется после любого рендера.
    var backHost = $("#app");
    if (backHost && window.MutationObserver) {
      new MutationObserver(function () { ensureBackBar(); })
        .observe(backHost, { childList: true });
    }
    loadSession();
  }

  async function loadSession() {
    // V194.6.3 (доп.): «призрачная» сессия удалённого аккаунта гасится сразу —
    // getUser() проверяет живого пользователя на сервере, а не только JWT.
    var liveUser = await verifyLiveSession();
    await loadProfile();
    renderSessionBadge();
    // V194.6.3: незавершённая регистрация (нет пароля) не пускает в кабинет.
    try {
      await maybeResumeRegistration(liveUser);
    } catch (e) {
      console.warn("[reg] восстановление регистрации:", e);
    }
    // V193.10: права сотрудника подтягиваются вместе с профилем и скрывают пункты меню.
    try {
      await loadMyPermissions();
      applyNavPermissions();
    } catch (e) {
      console.warn("[permissions]", e);
    }
    if (state.userId) {
      // V192.2 (ТЗ §1): после перезагрузки страницы слежение восстанавливается.
      var saved = readWebSession();
      if (saved && (saved.token || saved.session_id)) {
        startSessionWatch(saved.token, saved.session_id);
        checkSessionAlive();
      }
    } else {
      stopSessionWatch();
      clearWebSession();
    }
    renderRoute();
  }

  document.addEventListener("DOMContentLoaded", init);
})();












