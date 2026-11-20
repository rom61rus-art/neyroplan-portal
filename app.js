/* V192.5: единственный канонический адрес портала — https://neyroplan.ru.
   Старый домен Render и зеркало GitHub Pages отдают только редирект, чтобы
   пользователь не работал на устаревшей сборке. */
(function () {
  var host = String((window.location && window.location.hostname) || "").toLowerCase();
  var isLegacyRender = host === "neyroplan-portal.onrender.com";
  var isLegacyPages = /(^|\.)github\.io$/.test(host);
  if (!isLegacyRender && !isLegacyPages) return;
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
    activeProjectId: 0,
    calcTomes: [],
    selectedTomes: {},
    calcProjects: [],
    // V192.6: админка открывается только после подтверждения (QR или пароль) на 30 минут.
    adminVerifiedUntil: 0,
    adminVerify: { token: "", timer: null, expiresAt: 0 },
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

  function toast(message, ms) {
    var node = $("#toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { node.classList.add("hidden"); }, ms || 3200);
  }

  function openModal(title, html) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-backdrop").classList.remove("hidden");
  }
  function closeModal() {
    $("#modal-backdrop").classList.add("hidden");
    $("#modal-body").innerHTML = "";
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
      return null;
    }
    state.userId = session.user.id;
    state.userEmail = String((session.user && session.user.email) || "");
    var res = await sb.from("profiles")
      .select("id, full_name, role, organization_id, is_superadmin, email, account_type")
      .eq("id", session.user.id).maybeSingle();
    state.profile = res.data || null;
    state.orgId = num(res.data && res.data.organization_id);
    // V192.6: владелец платформы — строго по profiles (is_superadmin или role=superadmin).
    var roleCode = String((res.data && res.data.role) || "").trim().toLowerCase();
    state.isSuper = !!(
      (res.data && (res.data.is_superadmin === true || res.data.is_superadmin === 1)) ||
      roleCode === "superadmin" || roleCode === "суперадмин"
    );
    if (res.data && res.data.email) state.userEmail = String(res.data.email);
    state.orgName = await loadOrganizationName(state.orgId);
    // V192.7: метка последнего входа — видна в админской таблице пользователей.
    // V194.5 (ТЗ §5.2): пишем ещё и last_seen_at — реальная дата визита
    // (столбец «Последний визит»), с фолбэком на last_login_at.
    try {
      var stamp = new Date().toISOString();
      var touch = await sb.from("profiles")
        .update({ last_login_at: stamp, last_seen_at: stamp })
        .eq("id", session.user.id);
      if (touch.error) {
        await sb.from("profiles").update({ last_login_at: stamp })
          .eq("id", session.user.id);
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

  function renderSessionBadge() {
    var badge = $("#session-badge");
    var nameNode = $("#session-name");
    var metaNode = $("#session-meta");
    var login = $("#btn-login");
    var logout = $("#btn-logout");
    var adminLink = $("#nav-admin");
    if (state.userId) {
      var fullName = (state.profile && state.profile.full_name) || state.userEmail || "Подрядчик";
      var roleLabel = roleTitle(state.profile && state.profile.role);
      var orgLabel = state.orgName || (state.isSuper ? "Владелец платформы" : "Организация");
      if (nameNode) nameNode.textContent = fullName;
      if (metaNode) metaNode.textContent = [orgLabel, roleLabel].filter(Boolean).join(" · ");
      if (badge) badge.classList.remove("hidden");
      if (login) login.classList.add("hidden");
      if (logout) logout.classList.remove("hidden");
    } else {
      if (badge) badge.classList.add("hidden");
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
      '<button class="btn btn-ghost" id="hero-tariffs" type="button">Тарифы и подписка</button>' +
      '<button class="btn btn-ghost" id="hero-partners" type="button">Для партнёров</button>' +
      "</div>" +
      '<div class="hero-notes notranslate">' +
      '<span class="hero-note">Контур А · смета до копейки</span>' +
      '<span class="hero-note">ПД/РД · ведомость объёмов</span>' +
      '<span class="hero-note">КП и финансовая модель в 1 клик</span>' +
      "</div></div></section>" +

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

      '<section class="section"><h2 class="section-title">Обучение</h2>' +
      '<div class="grid grid-3 mt-16">' +
      learnCard("1. Первый аудит сметы", "Загрузите файл сметы — платформа соберёт 8-листовой отчёт с ценами, рисками и маржой.") +
      learnCard("2. Расчёт объекта по ПД/РД", "Загрузите тома проекта: КЖ, АР, КМ, ОВ, ВК, ЭОМ. Прогресс по каждому тому виден в реальном времени.") +
      learnCard("3. КП и защита прибыли", "Настройте проценты и налоговый режим, скачайте КП для заказчика и финансовую модель для директора.") +
      "</div></section>";

    renderDemo($("#demo-box"));
    var heroTry = $("#hero-try");
    if (heroTry) heroTry.addEventListener("click", function () { openRegistration("company_owner"); });
    var heroPartners = $("#hero-partners");
    if (heroPartners) heroPartners.addEventListener("click", openPartnerApplyModal);
    var heroTariffs = $("#hero-tariffs");
    if (heroTariffs) heroTariffs.addEventListener("click", openTariffsModal);
    $all("[data-showcase]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openModuleDemo(btn.getAttribute("data-showcase"));
      });
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

  /// Тарифы и подписка — страница-заглушка (раздел в разработке).
  function openTariffsModal() {
    openModal("Тарифы и подписка",
      '<div class="demo-shot"><strong>Раздел в разработке.</strong><br>Скоро появятся тарифные планы ' +
      "для компаний и частных мастеров: базовый аудит смет, расчёт по ПД/РД, командные права и " +
      "модули объекта.</div>" +
      '<div class="mt-16 flex"><button class="btn btn-navy" id="tariff-register" type="button">' +
      "Оставить заявку на ранний доступ</button></div>");
    $("#tariff-register").addEventListener("click", function () {
      closeModal();
      openRegistration("company_owner");
    });
  }

  function compareRow(op, old, neu) {
    return "<tr><td><strong>" + esc(op) + "</strong></td><td>" + esc(old) +
      "</td><td><strong>" + esc(neu) + "</strong></td></tr>";
  }
  function roleCard(title, text) {
    return '<div class="card"><h3>' + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
  }
  function learnCard(title, text) {
    return '<div class="card"><h3>' + esc(title) + "</h3><p>" + esc(text) +
      '</p><div class="mt-8 small muted">Доступно после входа в кабинет</div></div>';
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

  function estimateStatusPill(status) {
    var map = {
      queued: ["В очереди", "warn"], processing: ["Обработка", "info"],
      done: ["Готово", "ok"], failed: ["Ошибка", "bad"],
    };
    var pair = map[status] || [status || "—", "navy"];
    return pill(pair[0], pair[1]);
  }

  async function renderCabinet(root) {
    root.innerHTML = '<div class="muted">Загрузка объектов и смет…</div>';
    if (!(await requireAuth(root))) return;
    await loadProjectsList();

    var jobsRes = await sb.from("estimate_jobs")
      .select("id, status, source_name, report_path, contract_total, market_total, summary, error_message, created_at")
      .order("created_at", { ascending: false }).limit(40);
    var jobs = jobsRes.data || [];

    root.innerHTML =
      '<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
      '<div style="flex:1 1 220px;min-width:0;">' +
      '<div class="small muted">Организация</div>' +
      '<div style="font-size:19px;font-weight:900;color:#0F172A;line-height:1.15;">' +
      esc(state.orgName || "Организация") + "</div>" +
      '<div class="small muted" style="margin-top:2px;">' + esc(roleTitleJs()) + "</div></div>" +
      '<div id="obj-switcher-slot"></div></div>' +
      '<div class="flex-between mt-16" style="gap:10px;align-items:flex-start;">' +
      '<div><h2 class="section-title" style="margin:0;">Объекты и сметы организации</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Загрузка смет, Генеральный свод, правка цен и ' +
      "8-листовой Excel. Объекты, фотоотчёты и камеры — во вкладке «Объекты».</p></div>" +
      '<div class="flex"><label class="btn btn-navy" for="estimate-file" style="cursor:pointer;">' +
      "Загрузить смету (.xlsx / .gsfx / .pdf)</label>" +
      '<input id="estimate-file" type="file" accept=".xlsx,.xlsm,.gsfx,.xml,.pdf" class="hidden" /></div></div>' +
      '<div class="grid grid-4 mt-16">' +
      kpi("Смет в работе", String(jobs.filter(function (j) { return j.status === "queued" || j.status === "processing"; }).length), "очередь estimate_jobs") +
      kpi("Готовых отчётов", String(jobs.filter(function (j) { return j.status === "done"; }).length), "8-листовой Excel") +
      kpi("Объектов", String((state.projects || []).length), "общий реестр организации") +
      kpi("Веб-кабинет", "QR-вход", "сессия выдана сервером") +
      "</div>" +
      '<div class="card mt-16" id="cabinet-jobs"></div>';

    mountObjectSwitcher();
    renderJobsTable($("#cabinet-jobs"), jobs);

    $("#estimate-file").addEventListener("change", async function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      await uploadEstimate(file);
    });
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
        '<td class="num">' + pct(pom.margin_percent || 0) + "</td>" +
        '<td><div class="flex"><button class="btn btn-outline btn-sm" data-report="' + esc(job.id) + '" data-path="' +
        esc(job.report_path || "") + '">Excel</button>' +
        '<button class="btn btn-outline btn-sm" data-prices="' + esc(job.id) + '">Правка цен</button></div></td></tr>';
    }).join("");
    container.innerHTML =
      '<h3>Сметы</h3><div class="table-wrap mt-8"><table class="data"><thead><tr>' +
      "<th>Файл</th><th>Статус</th><th class=\"num\">Смета, ₽</th><th class=\"num\">Рынок, ₽</th>" +
      "<th class=\"num\">Маржа</th><th>Действия</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="small muted mt-8">«Правка цен» отправляет instant-пересчёт recalc_only: Excel и итоги пересобираются без ИИ.</p>';

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
    var res = await sb.from("company_unit_rates")
      .select("id, region, category, work_name, unit, unit_price, rate_type, is_turnkey")
      .order("work_name", { ascending: true }).limit(1000);
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

  function rateRow(row) {
    return "<tr><td>" + esc(row.work_name) + "</td><td>" + esc(row.category) + "</td><td>" + esc(row.unit) +
      '</td><td class="num"><input type="number" step="0.01" style="width:120px;text-align:right;" data-rate-price="' +
      esc(row.id) + '" value="' + num(row.unit_price) + '" /></td><td>' + esc(row.region || "") + "</td>" +
      '<td><div class="flex"><button class="btn btn-outline btn-sm" data-rate-save="' + esc(row.id) + '">Сохранить</button>' +
      '<button class="btn btn-danger btn-sm" data-rate-del="' + esc(row.id) + '">Удалить</button></div></td></tr>';
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
      // V193.9: режим объёма работ ПТО. По умолчанию — строго по спецификации.
      calc_scope: "strict_spec",
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
      var job = jobs[0] || null;
      state.calcJob = job;
      state.calcJobId = job ? job.id : null;
      if (job && job.commercial_params) {
        state.calcParams = Object.assign(state.calcParams, job.commercial_params);
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
      toast("Документы ещё не сформированы: сначала «Рассчитать ₽»", 6000);
      return;
    }
    openModal("Документы расчёта",
      '<div class="flex" style="flex-direction:column;align-items:stretch;gap:8px;">' +
      '<button class="btn btn-navy btn-sm" data-doc="' + esc(job.cost_xlsx_path || "") +
      '" type="button">Финансовая модель .xlsx</button>' +
      '<button class="btn btn-navy btn-sm" data-doc="' + esc(job.kp_xlsx_path || "") +
      '" type="button">КП .xlsx</button>' +
      '<button class="btn btn-navy btn-sm" data-doc="' + esc(job.kp_docx_path || "") +
      '" type="button">КП .docx</button></div>');
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
      var scope = String((job.commercial_params || {}).calc_scope || volumes.calc_scope || "strict_spec");
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
      return '<div class="calc-row is-' + cls + '" data-job="' + esc(job.id) + '">' +
        '<div class="cr-icon">' + (String(job.status) === "error" ? "!" :
          (running ? "⏳" : (docsReady ? "✓" : "📄"))) + "</div>" +
        '<div class="cr-main" data-job-open="' + esc(job.id) + '" style="cursor:pointer;">' +
        '<div class="cr-title">' + esc(title) + "</div>" +
        '<div class="cr-sub">' + esc(updated + " · " + files + " том(ов)") +
        (scope === "full_cycle" ? " · ИИ-ПТО" : "") + "</div></div>" +
        '<div class="cr-right">' + pill(badge, cls === "bad" ? "bad" : (cls === "ok" ? "ok" : "info")) +
        (amount ? '<span class="cr-sum">' + amount + "</span>" : "") +
        '<button class="btn btn-outline btn-sm" data-job-tomes="' + esc(job.id) + '" type="button">PDF</button>' +
        (docsReady
          ? '<button class="btn btn-navy btn-sm" data-job-docs="' + esc(job.id) + '" type="button">Excel / КП</button>'
          : '<button class="btn btn-navy btn-sm" data-job-price="' + esc(job.id) +
            '" type="button"' + (running || !atoms ? " disabled" : "") + ">₽</button>") +
        '<button class="btn btn-outline btn-sm" data-job-del="' + esc(job.id) + '" type="button">🗑</button>' +
        "</div></div>";
    }).join("");
    $all("[data-job-open]", box).forEach(function (btn) {
      btn.addEventListener("click", function () { openCalcJob(btn.getAttribute("data-job-open")); });
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
      '<option value="strict_spec">Строго по спецификации проекта</option>' +
      '<option value="full_cycle">Полный строительный цикл (ИИ-ПТО)</option></select></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="run-go" type="button">' +
      "Разобрать объёмы</button></div>");
    var scopeSelect = $("#run-scope");
    if (scopeSelect) {
      scopeSelect.value = (state.calcParams && state.calcParams.calc_scope === "full_cycle")
        ? "full_cycle" : "strict_spec";
    }
    var goBtn = $("#run-go");
    if (goBtn) {
      goBtn.addEventListener("click", function () {
        var regionField = $("#run-region");
        var region = String((regionField && regionField.value) || "").trim();
        state.calcParams = Object.assign({}, state.calcParams || {}, {
          region: region,
          calc_scope: scopeSelect ? scopeSelect.value : "strict_spec",
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
        calc_scope: (state.calcParams && state.calcParams.calc_scope === "full_cycle")
          ? "full_cycle" : "strict_spec",
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
      calc_scope: (state.calcParams && state.calcParams.calc_scope) ||
        (job.commercial_params || {}).calc_scope || "strict_spec",
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
    if (!job) { box.innerHTML = ""; return; }
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
    // V193.9: сохраняем все 9 полей commercial_params + режим объёма работ.
    var payload = Object.assign({}, calcParamsDefaults(), state.calcParams, {
      calc_scope: state.calcParams.calc_scope === "full_cycle"
        ? "full_cycle" : "strict_spec",
      recalc_only: true,
    });
    var upd = await sb.from("project_calc_jobs").update({ commercial_params: payload }).eq("id", job.id);
    if (upd.error) { toast("Не удалось сохранить КП: " + upd.error.message); return; }
    toast("Параметры КП сохранены: документы пересчитает воркер без ИИ");
    refreshCalcJob();
  }

// ═════════ V192.9: наглядный мониторинг и заявки поставщиков ═════════
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
      var workerDetails = workerOk
        ? "релиз " + esc(health.release || "—") + " · аптайм " +
          Math.round(num(health.uptime_s) / 60) + " мин"
        : esc((health && (health.error || health.status)) || "нет ответа");
      var routerai = (providers && providers.routerai) || {};
      var artemox = (providers && providers.artemox) || {};
      var deepseek = (providers && providers.deepseek) || {};
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
        adminStatusCard("Python-воркер", workerOk ? "ok" : "bad", workerDetails) +
        adminStatusCard("Воркер ПД/РД", projectOk ? "ok" : "bad", projectDetails) +
        adminStatusCard("RouterAI · gemini-3.8-flash",
          routerai.configured && routerai.status === "ok" ? "ok" : (routerai.configured ? "warn" : "bad"),
          esc(routerai.label || "RouterAI") + " · баланс " +
          (routerai.balance == null ? "—" : esc(routerai.balance) + " " + esc(routerai.currency || ""))) +
        adminStatusCard("DeepSeek Direct", deepseekOk ? "ok" : (deepseek.configured ? "warn" : "bad"),
          deepseekDetails) +
        adminStatusCard("Artemox · hydrogen",
          artemox.configured && artemox.status ? "ok" : (artemox.configured ? "warn" : "bad"),
          esc(artemox.label || "Artemox") + " · " + esc(artemox.status || "—")) +
        adminStatusCard("База данных Supabase", dbOk ? "ok" : "bad",
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
      .select("id, name, created_at, inn, kpp, ogrn, tariff_plan, estimates_limit_month, access_until, is_blocked, is_price_partner")
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

    var orgList = orgs.data || [];
    var profileList = profiles.data || [];
    var jobList = jobs.data || [];
    var marketplacePosts = marketplaceRes.data || [];
    var partnerApps = appsRes.data || [];
    var visitList = visitsRes.data || [];
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
      var limit = num(org.estimates_limit_month);
      return "<tr><td>" + esc(org.id) + '</td><td><strong>' + esc(org.name || "Организация") +
        '</strong><div class="small muted">ИНН ' + esc(org.inn || "—") + " · КПП " + esc(org.kpp || "—") +
        (org.is_price_partner ? " · " + pill("партнёр Книги цен", "ok") : "") + "</div></td>" +
        "<td>" + esc(tariffTitle(org.tariff_plan)) + "</td>" +
        '<td class="num">' + (limit > 0 ? limit : "∞") + "</td>" +
        '<td class="small">' + esc(fmtDate(org.access_until)) + "</td>" +
        '<td class="num">' + users + "</td>" +
        '<td class="num">' + orgJobs.length + "</td>" +
        '<td class="num">' + done + "</td>" +
        "<td>" + orgStatusPill(org) + "</td>" +
        '<td><div class="flex">' +
        '<button class="btn btn-outline btn-sm" data-org-tariff="' + esc(org.id) + '" type="button">Тариф и лимиты</button>' +
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
      '<div class="card mt-16"><h3>Организации, тарифы и лимиты</h3>' +
      '<div class="table-wrap mt-8" style="max-height:52vh;overflow:auto;"><table class="data"><thead><tr>' +
      '<th>ID</th><th>Организация</th><th>Тариф</th><th class="num">Лимит/мес</th><th>Доступ до</th>' +
      '<th class="num">Люди</th><th class="num">Сметы</th><th class="num">Готово</th><th>Статус</th><th>Действия</th>' +
      "</tr></thead><tbody>" +
      (orgRows || '<tr><td colspan="10" class="muted">Организаций пока нет.</td></tr>') +
      "</tbody></table></div></div>" +
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
      '<span class="small muted">Проверка: signInWithPassword (Supabase Auth)</span></div></div>');
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
      box.innerHTML = '<p class="small muted">Операций по фильтру нет.</p>';
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
      root.innerHTML = '<div class="warn-box">Организация не определена: войдите в аккаунт компании.</div>';
      return;
    }
    var res = await sb.from("project_users")
      .select("*")
      .eq("organization_id", state.orgId)
      .order("name", { ascending: true }).limit(500);
    var users = res.data || [];
    var accessRes = await sb.from("profiles")
      .select("id, full_name, email, role, account_type, last_login_at, is_superadmin")
      .eq("organization_id", state.orgId)
      .limit(500);
    var access = accessRes.data || [];
    var orgInvRes = await sb.from("org_invites")
      .select("id, code, role, expires_at, used_by, used_at, is_reusable, created_at")
      .eq("org_id", state.orgId)
      .order("created_at", { ascending: false }).limit(50);
    var orgInvites = orgInvRes.data || [];
    // V193.10: одноразовые использованные коды «сгорают» и в активных не показываются.
    var activeInvites = orgInvites.filter(function (row) {
      return !row.used_by || row.is_reusable === true;
    });
    var usedInvites = orgInvites.filter(function (row) {
      return row.used_by && row.is_reusable !== true;
    });
    var active = users.filter(function (u) {
      return String(u.status || "Активен").toLowerCase().indexOf("актив") >= 0;
    }).length;
    var ownerEmail = String(state.userEmail || "").toLowerCase();
    var ownerUserId = String(state.userId || "");

    root.innerHTML =
      '<div class="flex-between"><div><h2 class="section-title" style="margin:0;">Команда</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Сотрудники организации «' + esc(state.orgName || "—") +
      "»: роль, должность, матрица прав и коды приглашений.</p></div>" +
      '<div class="flex">' + (state.isSuper ? pill("Владелец платформы", "ok") : "") + "</div></div>" +
      '<div class="grid grid-4 mt-16">' +
      kpi("Сотрудников", String(users.length), "в организации") +
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
      '<div class="card mt-16"><h3>Сотрудники: роли, должности и права</h3>' +
      '<p class="small muted">Матрица прав едина для сайта и приложения: выключенный модуль ' +
      "скрывается и в меню, и на телефоне.</p>" +
      '<div class="table-wrap mt-8" style="max-height:56vh;overflow:auto;"><table class="data"><thead><tr>' +
      "<th>Сотрудник</th><th>Контакты</th><th>Роль</th><th>Должность</th><th>Вход</th><th>Действия</th>" +
      "</tr></thead><tbody>" +
      (users.length ? users.map(function (user) {
        return teamRowHtml(user, ownerEmail, ownerUserId);
      }).join("") : (access.length
        ? access.map(function (row) {
            return "<tr><td>" + esc(row.full_name || "—") + "</td><td>" + esc(row.email || "") +
              "</td><td>" + esc(roleTitle(row.role)) + "</td><td>" +
              esc(accountTypeTitle(row.account_type)) + '</td><td class="small">' +
              esc(fmtDate(row.last_login_at)) + "</td><td>—</td></tr>";
          }).join("")
        : '<tr><td colspan="6" class="muted">Сотрудников пока нет.</td></tr>')) +
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
      if (input.getAttribute("data-owner") === "1") { input.disabled = true; return; }
      input.addEventListener("change", function () {
        saveTeamTitle(input.getAttribute("data-team-title"), input.value);
      });
    });
    $all("[data-team-perms]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openMemberRights(btn.getAttribute("data-team-perms"));
      });
    });
  }




  function teamRowHtml(user, ownerEmail, ownerUserId) {
    // V193.1: роль показывается и сохраняется каноническим кодом.
    var role = normalizeRoleCode(user.role);
    var isOwner = (ownerUserId && String(user.auth_id || "") === ownerUserId) ||
      (ownerEmail && String(user.email || "").toLowerCase() === ownerEmail) ||
      user.is_superadmin === true;
    var options = TEAM_ROLES.map(function (item) {
      return '<option value="' + esc(item.code) + '"' + (item.code === role ? " selected" : "") +
        ">" + esc(item.title) + "</option>";
    }).join("");
    if (isOwner) {
      // Владелец не подписывается «Гостем» и защищён от сброса собственных прав.
      options = '<option value="DIRECTOR" selected>Руководитель (владелец)</option>';
    }
    var customTitle = String(user.custom_title || user.title || "").trim();
    return "<tr><td><strong>" + esc(user.name || "Сотрудник") + "</strong>" +
      (isOwner ? " " + pill("Владелец", "ok") : "") + "</td>" +
      "<td>" + esc(user.email || "") + (user.phone ? " · " + esc(user.phone) : "") + "</td>" +
      '<td><select data-team-role="' + esc(user.id) + '" data-owner="' + (isOwner ? 1 : 0) +
      '" style="min-width:170px;">' + options + "</select></td>" +
      '<td><input type="text" data-team-title="' + esc(user.id) + '" data-owner="' + (isOwner ? 1 : 0) +
      '" value="' + esc(customTitle) + '" placeholder="Должность (своя)" style="min-width:150px;" /></td>' +
      "<td>" + pill(user.auth_id ? "Вход разрешён" : "Без входа", user.auth_id ? "ok" : "warn") + "</td>" +
      '<td><button class="btn btn-outline btn-sm" data-team-perms="' + esc(user.id) +
      '" type="button">Права</button></td></tr>';
  }

  async function saveTeamTitle(userId, title) {
    var res = await sb.from("project_users")
      .update({ custom_title: String(title || "").trim().slice(0, 80) })
      .eq("id", num(userId));
    if (res.error) { toast("Должность не сохранена: " + res.error.message, 6000); return; }
    toast("Должность обновлена");
  }

  /// Модалка матрицы прав: тумблеры по всем модулям (единые для Web и Flutter).
  function openMemberRights(userId) {
    sb.from("project_users").select("*").eq("id", num(userId)).maybeSingle().then(function (res) {
      var row = res.data;
      if (!row) { toast("Сотрудник не найден"); return; }
      var toggles = TEAM_PERMISSIONS.map(function (item) {
        return '<label class="rights-row"><span>' + esc(item[1]) + "</span>" +
          '<input type="checkbox" data-perm="' + item[0] + '"' +
          (row[item[0]] === true ? " checked" : "") + " /></label>";
      }).join("");
      openModal("Права: " + (row.name || row.email || "сотрудник"),
        '<p class="small muted">Если модуль выключен — он скрывается в меню сайта и в приложении.</p>' +
        '<div class="rights-grid mt-8">' + toggles + "</div>" +
        '<div class="mt-16 flex"><button class="btn btn-navy" id="perms-save" type="button">' +
        "Сохранить права</button>" +
        '<span class="small muted">Изменения применяются сразу</span></div>');
      $("#perms-save").addEventListener("click", async function () {
        var patch = {};
        $all("[data-perm]").forEach(function (input) {
          patch[input.getAttribute("data-perm")] = input.checked;
        });
        patch.permissions_updated_at = new Date().toISOString();
        var upd = await sb.from("project_users").update(patch).eq("id", num(userId));
        if (upd.error) { toast("Права не сохранены: " + upd.error.message, 7000); return; }
        closeModal();
        toast("Матрица прав обновлена");
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
  ];
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
        if (row[item[0]] === true) permissions[item[0]] = true;
      });
      var code = normalizeRoleCode(row.role);
      if (code === "DIRECTOR" || row.is_superadmin === true) {
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
    var map = {
      "nav-objects": true,
      "nav-works": true,
      "nav-rates": can("can_view_estimates"),
      "nav-finance": can("can_view_finance_all") || can("can_view_subaccount"),
      "nav-team": can("can_manage_users"),
      "nav-project": can("can_view_estimates"),
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
      '<button class="btn btn-outline btn-sm" id="chat-settings" type="button">Настройки</button></div>' +
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
    feed.innerHTML = rows.map(function (row) {
      return '<div style="padding:8px 0;border-bottom:1px solid #E2E8F0;">' +
        '<div class="small"><strong>' + esc(row.sender_name || "Сотрудник") + "</strong>" +
        ' <span class="muted">' + esc(String(row.timestamp || row.created_at || "").slice(0, 16).replace("T", " ")) +
        "</span></div>" +
        (row.message ? '<div class="mt-8">' + esc(row.message) + "</div>" : "") +
        (row.photo_path ? '<div class="mt-8"><button class="btn btn-outline btn-sm" data-chat-file-open="' +
          esc(row.photo_path) + '">Открыть файл</button></div>' : "") +
        "</div>";
    }).join("");
    feed.scrollTop = feed.scrollHeight;
    $all("[data-chat-file-open]", feed).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var signed = await sb.storage.from("chat_files")
          .createSignedUrl(btn.getAttribute("data-chat-file-open"), 3600);
        if (signed.error) { toast("Файл недоступен: " + signed.error.message); return; }
        window.open(signed.data.signedUrl, "_blank");
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
      sender_name: (state.profile && (state.profile.full_name || state.profile.role)) || "Портал",
      sender_role: (state.profile && state.profile.role) || "Сотрудник",
      message: "Файл: " + file.name,
      photo_path: path,
      timestamp: new Date().toISOString(),
    });
    event.target.value = "";
    if (res.error) { toast("Файл загружен, но сообщение не создано: " + res.error.message, 6000); }
  }

  // ─────────────────────────────── Роутер ───────────────────────────────
  // ═══════════════ V192.7 (Спринт 2): управление организациями ═══════════════
  var TARIFF_PLANS = [
    { code: "demo", title: "Демо 7 дней" },
    { code: "basic", title: "Базовый" },
    { code: "pro", title: "Про" },
    { code: "unlimited", title: "Безлимит" },
  ];

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

  function openOrgTariffModal(org) {
    if (!org) return;
    var options = TARIFF_PLANS.map(function (plan) {
      return '<option value="' + esc(plan.code) + '"' +
        ((org.tariff_plan || "demo") === plan.code ? " selected" : "") + ">" +
        esc(plan.title) + "</option>";
    }).join("");
    var until = String(org.access_until || "").slice(0, 10);
    openModal("Тариф и лимиты · " + (org.name || ("Организация " + org.id)),
      '<div class="form-row">' +
      '<label class="field"><span>Тариф</span><select id="ot-plan">' + options + "</select></label>" +
      '<label class="field"><span>Лимит смет в месяц (0 — без ограничения)</span>' +
      '<input type="number" min="0" step="1" id="ot-limit" value="' + num(org.estimates_limit_month) + '" /></label>' +
      '<label class="field"><span>Доступ до (дата)</span>' +
      '<input type="date" id="ot-until" value="' + esc(until) + '" /></label>' +
      "</div>" +
      '<div class="warn-box mt-16">ИНН: ' + esc(org.inn || "—") + " · КПП: " + esc(org.kpp || "—") +
      " · ОГРН: " + esc(org.ogrn || "—") + "</div>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="ot-save" type="button">Сохранить</button>' +
      '<span class="small muted">Лимит смет и дата доступа применяются к организации.</span></div>');
    $("#ot-save").addEventListener("click", async function () {
      var dateText = String($("#ot-until").value || "").trim();
      var patch = {
        tariff_plan: $("#ot-plan").value,
        estimates_limit_month: Math.max(0, Math.round(num($("#ot-limit").value))),
        access_until: dateText ? new Date(dateText + "T23:59:59Z").toISOString() : null,
      };
      var res = await sb.from("organizations").update(patch).eq("id", org.id);
      if (res.error) { toast("Тариф не сохранён: " + res.error.message, 6000); return; }
      closeModal();
      toast("Тариф обновлён: " + tariffTitle(patch.tariff_plan));
      renderRoute();
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
      var lastVisit = fmtDate(p.last_seen_at || p.last_login_at || "");
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
        '<td class="small">' + esc(fmtDate(p.last_login_at || p.created_at)) + "</td>" +
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
      root.innerHTML = '<div class="card"><h3>Организация не привязана</h3>' +
        '<p class="small muted">Аккаунт частного мастера/бригадира работает без организации — ' +
        "реквизиты и фирменный бланк доступны компаниям.</p></div>";
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
        otpSent: false,
        lookup: null,
      };
    }
    return state.reg;
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

  function openRegistration(branch, inviteCode) {
    var reg = regState();
    reg.account_type = branch || "company_owner";
    reg.invite_code = String(inviteCode || reg.invite_code || "");
    reg.otpSent = false;
    openModal("Регистрация в НейроПлане", '<div id="reg-body"></div>');
    renderRegistrationForm();
  }

  function regField(id, label, type, value, placeholder) {
    return '<label class="field"><span>' + esc(label) + "</span>" +
      '<input type="' + (type || "text") + '" id="' + id + '" value="' + esc(value || "") +
      '" placeholder="' + esc(placeholder || "") + '" /></label>';
  }

  function regConsentRow(id, text) {
    return '<label class="flex" style="align-items:flex-start;gap:8px;margin-top:10px;">' +
      '<input type="checkbox" id="' + id + '" />' +
      '<span class="small">' + text + "</span></label>";
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
    var fields = "";
    if (reg.account_type === "company_owner") {
      fields =
        '<div class="form-row mt-8">' +
        regField("reg-inn", "ИНН организации", "text", reg.lookup ? reg.lookup.inn : "", "10 или 12 цифр") +
        regField("reg-org-name", "Название организации", "text", reg.lookup ? reg.lookup.name : "", "ООО «СтройИнвест»") +
        regField("reg-director", "ФИО руководителя", "text", reg.lookup ? reg.lookup.director_name : "", "Иванов Иван Иванович") +
        "</div>" +
        '<div class="flex mt-8"><button class="btn btn-outline btn-sm" id="reg-inn-check" type="button">Проверить ИНН</button>' +
        '<span class="small" id="reg-inn-status"></span></div>';
    } else if (reg.account_type === "employee") {
      fields =
        '<div class="form-row mt-8">' +
        regField("reg-invite", "Код приглашения от руководителя", "text", reg.invite_code, "6–12 символов") +
        regField("reg-fullname", "ФИО", "text", "", "Петров Пётр Петрович") +
        "</div>" +
        '<p class="small muted mt-8">Код выдаёт руководитель в разделе «Команда». ИНН не нужен.</p>';
    } else {
      var specOptions = SPECIALIZATIONS.map(function (item) {
        return "<option>" + esc(item) + "</option>";
      }).join("");
      fields =
        '<div class="form-row mt-8">' +
        regField("reg-fullname", "ФИО", "text", "", "Сидоров Иван Петрович") +
        '<label class="field"><span>Специализация</span><select id="reg-spec">' + specOptions + "</select></label>" +
        regField("reg-brigade", "Размер бригады", "number", "1", "1") +
        "</div>";
    }
    var common =
      '<div class="form-row mt-8">' +
      regField("reg-email", "E-mail", "email", reg.email, "master@company.ru") +
      regField("reg-phone", "Телефон", "tel", "", "+7 900 000-00-00") +
      regField("reg-city", "Город", "text", "", "Москва") +
      "</div>";
    var catalogConsent = reg.account_type === "brigadier"
      ? regConsentRow("reg-consent-catalog",
        "Даю согласие на публикацию моих контактов и специализации в каталоге подрядчиков " +
        "для заказчиков платформы (ст. 10.1 152-ФЗ).")
      : "";
    box.innerHTML =
      '<p class="small muted">Выберите тип аккаунта — от него зависит набор данных и демо-доступ.</p>' +
      '<div class="flex mt-8">' + tabs + "</div>" +
      fields + common +
      '<div class="mt-16" style="border-top:1px solid #E2E8F0;padding-top:10px;">' +
      regConsentRow("reg-consent-terms",
        "Принимаю Условия использования и Политику конфиденциальности (обязательно).") +
      regConsentRow("reg-consent-pdn",
        "Даю согласие на обработку моих персональных данных (ФИО, телефон, e-mail) " +
        "в соответствии с 152-ФЗ (обязательно).") +
      catalogConsent +
      "</div>" +
      '<div class="flex mt-16"><button class="btn btn-navy" id="reg-send-otp" type="button">Получить код на e-mail</button>' +
      '<span class="small muted">Код подтверждения приходит письмом Supabase Auth.</span></div>';

    $all("[data-reg-branch]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        regState().account_type = btn.getAttribute("data-reg-branch");
        renderRegistrationForm();
      });
    });
    var checkBtn = $("#reg-inn-check");
    if (checkBtn) checkBtn.addEventListener("click", regLookupInn);
    $("#reg-send-otp").addEventListener("click", regSendOtp);
  }


  function regReadForm() {
    var reg = regState();
    function val(id) {
      var node = $("#" + id);
      return node ? String(node.value || "").trim() : "";
    }
    return {
      account_type: reg.account_type,
      full_name: val("reg-fullname"),
      email: val("reg-email"),
      phone: val("reg-phone"),
      city: val("reg-city"),
      inn: val("reg-inn").replace(/\D+/g, ""),
      org_name: val("reg-org-name"),
      director_name: val("reg-director"),
      invite_code: val("reg-invite").toUpperCase(),
      specialization: val("reg-spec"),
      brigade_size: Math.max(1, Math.round(num(val("reg-brigade") || "1"))),
      consents: {
        terms_privacy: !!($("#reg-consent-terms") && $("#reg-consent-terms").checked),
        pdn_processing: !!($("#reg-consent-pdn") && $("#reg-consent-pdn").checked),
        public_catalog_10_1: !!($("#reg-consent-catalog") && $("#reg-consent-catalog").checked),
      },
      user_agent: String((window.navigator && window.navigator.userAgent) || "").slice(0, 300),
    };
  }

  async function regLookupInn() {
    var inn = String(($("#reg-inn") && $("#reg-inn").value) || "").replace(/\D+/g, "");
    var statusNode = $("#reg-inn-status");
    if (!inn) { toast("Введите ИНН"); return; }
    if (statusNode) statusNode.innerHTML = '<span class="pill pill-info">Проверяем ИНН…</span>';
    var data = await invokeRegistration({ action: "lookup_inn", inn: inn });
    if (!data || data.ok !== true) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-bad">' +
          esc((data && (data.message || data.error)) || "ИНН не проверен") + "</span>";
      }
      return;
    }
    regState().lookup = data;
    if (data.already_registered) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-warn">Этот ИНН уже зарегистрирован — демо-доступ использован</span>';
      }
    } else if (data.manual_fill) {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-info">Контрольная сумма верна. ' +
          "DaData недоступна — заполните название и руководителя вручную</span>";
      }
    } else {
      if (statusNode) {
        statusNode.innerHTML = '<span class="pill pill-ok">' + esc(data.name || "Организация найдена") +
          (data.status ? " · " + esc(data.status) : "") + "</span>";
      }
    }
    if (data.name) {
      var nameNode = $("#reg-org-name");
      if (nameNode && !nameNode.value.trim()) nameNode.value = data.name;
    }
    if (data.director_name) {
      var dirNode = $("#reg-director");
      if (dirNode && !dirNode.value.trim()) dirNode.value = data.director_name;
    }
  }

  async function regSendOtp() {
    var form = regReadForm();
    if (!form.consents.terms_privacy || !form.consents.pdn_processing) {
      toast("Отметьте оба обязательных согласия (Условия/Политика и 152-ФЗ)", 7000);
      return;
    }
    if (!form.email || form.email.indexOf("@") < 0) { toast("Укажите корректный e-mail"); return; }
    if (form.account_type === "company_owner" && form.inn.length !== 10 && form.inn.length !== 12) {
      toast("ИНН организации — 10 или 12 цифр");
      return;
    }
    if (form.account_type === "employee" && form.invite_code.length < 6) {
      toast("Код приглашения — не короче 6 символов");
      return;
    }
    var btn = $("#reg-send-otp");
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем код…"; }
    var res = await sb.auth.signInWithOtp({
      email: form.email,
      options: { shouldCreateUser: true },
    });
    if (btn) { btn.disabled = false; btn.textContent = "Получить код на e-mail"; }
    if (res.error) { toast("Код не отправлен: " + res.error.message, 7000); return; }
    regState().email = form.email;
    regState().otpSent = true;
    regState().pending = form;
    renderOtpStep(form.email);
  }

  function renderOtpStep(email) {
    var box = $("#reg-body");
    if (!box) return;
    box.innerHTML =
      '<p class="small">Код подтверждения отправлен на <strong>' + esc(email) + "</strong>. " +
      "Введите 6 цифр из письма.</p>" +
      '<label class="field mt-8"><span>Код из письма</span>' +
      '<input type="text" id="reg-otp" inputmode="numeric" maxlength="6" placeholder="000000" /></label>' +
      '<div class="flex mt-16"><button class="btn btn-navy" id="reg-verify" type="button">Подтвердить и завершить</button>' +
      '<button class="btn btn-outline" id="reg-back" type="button">Назад</button></div>';
    $("#reg-verify").addEventListener("click", regVerifyOtp);
    $("#reg-back").addEventListener("click", renderRegistrationForm);
  }

  async function regVerifyOtp() {
    var code = String(($("#reg-otp") && $("#reg-otp").value) || "").trim();
    var email = regState().email;
    if (!/^[0-9]{6}$/.test(code)) { toast("Код — 6 цифр из письма"); return; }
    var btn = $("#reg-verify");
    if (btn) { btn.disabled = true; btn.textContent = "Проверяем…"; }
    var verify = await sb.auth.verifyOtp({ email: email, token: code, type: "email" });
    if (verify.error) {
      if (btn) { btn.disabled = false; btn.textContent = "Подтвердить и завершить"; }
      toast("Код не принят: " + verify.error.message, 7000);
      return;
    }
    var form = regState().pending || regReadForm();
    form.email = email;
    var data = await invokeRegistration(Object.assign({ action: "complete_registration" }, form));
    if (btn) { btn.disabled = false; btn.textContent = "Подтвердить и завершить"; }
    if (!data || data.ok !== true) {
      toast("Регистрация не завершена: " + String((data && (data.message || data.error)) || "ошибка"), 8000);
      return;
    }
    await loadProfile();
    renderSessionBadge();
    closeModal();
    toast("Регистрация завершена: " + accountTypeTitle(data.account_type), 6000);
    location.hash = "#/cabinet";
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

  function contractorsTabs(active) {
    function btn(code, title) {
      return '<button class="btn ' + (active === code ? "btn-navy" : "btn-outline") +
        ' btn-sm" data-contractors-tab="' + code + '" type="button">' + title + "</button>";
    }
    return '<div class="flex mt-8">' +
      btn("base", "Моя база бригад") +
      btn("board", "Биржа подрядов") +
      "</div>";
  }

  function bindContractorsTabs(root) {
    $all("[data-contractors-tab]", root).forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.contractorsTab = btn.getAttribute("data-contractors-tab");
        renderContractors(root);
      });
    });
  }

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

  async function renderContractors(root) {
    if (!(await requireAuth(root))) return;
    var tab = state.contractorsTab === "board" ? "board" : "base";
    if (tab === "board") {
      await renderMarketplaceBoard(root);
      return;
    }
    root.innerHTML = '<div class="muted">Загрузка базы бригад…</div>';
    var res = await sb.from("org_contractors").select("*")
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
      contractorsTabs("base") +
      '<div class="flex-between mt-16"><div><h2 class="section-title" style="margin:0;">Моя база бригад</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Проверенные подрядчики и бригадиры организации: ' +
      "телефон, специализация, город, оценка и комментарии прорабов.</p></div>" +
      '<button class="btn btn-navy" id="contractor-add" type="button">Добавить подрядчика</button></div>' +
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

    bindContractorsTabs(root);
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
  function marketplaceMediaHtml(post, size) {
    var media = Array.isArray(post.media_urls) ? post.media_urls : [];
    var side = size || 96;
    var first = media.length ? String(media[0]) : "";
    var isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(first) || first.indexOf("video") >= 0;
    var preview = first
      ? (isVideo
        ? '<div style="width:100%;height:100%;display:grid;place-items:center;background:#0F172A;color:#93C5FD;font-size:22px;">▶</div>'
        : '<img src="' + esc(first) + '" alt="Портфолио" style="width:100%;height:100%;object-fit:cover;" />')
      : '<div style="width:100%;height:100%;display:grid;place-items:center;background:#E2E8F0;color:#64748B;font-size:11px;">нет фото</div>';
    var counter = media.length
      ? '<span style="position:absolute;right:4px;bottom:4px;background:rgba(15,23,42,.78);color:#fff;' +
        'font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;">1/' + media.length + "</span>"
      : "";
    return '<div style="position:relative;flex:0 0 ' + side + "px;width:" + side + "px;height:" + side +
      'px;border-radius:10px;overflow:hidden;background:#E2E8F0;">' + preview + counter + "</div>";
  }

  function marketplaceTypeTitleShort(type) {
    return type === "brigade_available" ? "Бригада" : "Ищу подрядчика";
  }

  function marketplaceCardsHtml(rows, filters) {
    var city = String((filters || {}).city || "").toLowerCase();
    var spec = String((filters || {}).spec || "");
    var type = String((filters || {}).type || "");
    var list = (rows || []).filter(function (row) {
      if (city && String(row.city || "").toLowerCase().indexOf(city) < 0) return false;
      if (spec && String(row.specialization || "") !== spec) return false;
      if (type && String(row.post_type || "") !== type) return false;
      return true;
    });
    if (!list.length) {
      return '<div class="warn-box">Объявлений по фильтру нет. Опубликуйте своё — его увидят подрядчики региона.</div>';
    }
    return '<div class="grid" style="grid-template-columns:1fr;gap:10px;">' + list.map(function (post) {
      var mine = String(post.author_user_id) === String(state.userId);
      var budget = String(post.budget_text || "").trim();
      return '<div class="card" data-post-open="' + esc(post.id) + '" style="cursor:pointer;padding:12px;">' +
        '<div style="display:flex;gap:12px;align-items:flex-start;">' +
        marketplaceMediaHtml(post, 96) +
        '<div style="min-width:0;flex:1;">' +
        '<div class="small muted">' + esc(marketplaceTypeTitleShort(post.post_type)) + " · " +
        esc(fmtDate(post.created_at).slice(0, 10)) + "</div>" +
        '<div style="font-weight:800;font-size:14.5px;color:#0F172A;margin:2px 0;">' +
        esc(post.title) + "</div>" +
        (budget ? '<div style="font-weight:800;font-size:15px;color:#1F497D;">' + esc(budget) + "</div>" : "") +
        '<div class="small muted">' + esc(post.specialization) + " · " + esc(post.city) + "</div>" +
        '<div class="small muted">Контакт: ' + esc(post.contact_name) + " · " + esc(post.contact_phone) + "</div>" +
        "</div></div>" +
        '<div class="flex mt-8">' + contactButtonsHtml(post.contact_phone) +
        (mine ? '<button class="btn btn-outline btn-sm" data-post-archive="' + esc(post.id) +
          '" type="button">Снять с публикации</button>' +
          '<button class="btn btn-danger btn-sm" data-post-delete="' + esc(post.id) +
          '" type="button">Удалить</button>' : "") +
        (state.isSuper ? '<button class="btn btn-danger btn-sm" data-post-delete="' + esc(post.id) +
          '" type="button">Удалить (Админ)</button>' : "") +
        "</div></div>";
    }).join("") + "</div>";
  }

  function marketplaceGalleryHtml(post) {
    var media = Array.isArray(post.media_urls) ? post.media_urls : [];
    if (!media.length) {
      return '<div class="small muted">Автор не приложил фото или видео портфолио.</div>';
    }
    var main = String(media[0]);
    var isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(main) || main.indexOf("video") >= 0;
    var mainHtml = isVideo
      ? '<video src="' + esc(main) + '" controls style="width:100%;max-height:320px;border-radius:12px;background:#0F172A;"></video>'
      : '<img src="' + esc(main) + '" alt="Портфолио" style="width:100%;max-height:320px;object-fit:contain;border-radius:12px;background:#F8FAFC;" />';
    var thumbs = media.map(function (url, index) {
      var video = /\.(mp4|mov|webm)(\?|$)/i.test(String(url)) || String(url).indexOf("video") >= 0;
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener" ' +
        'style="width:56px;height:56px;border-radius:8px;overflow:hidden;background:#E2E8F0;' +
        'display:grid;place-items:center;text-decoration:none;color:#1F497D;font-size:16px;">' +
        (video ? "▶" : '<img src="' + esc(url) + '" alt="фото" style="width:100%;height:100%;object-fit:cover;" />') +
        "</a>";
    }).join("");
    return mainHtml + '<div class="flex mt-8">' + thumbs + "</div>";
  }

  function openPostDetail(post) {
    if (!post) return;
    var mine = String(post.author_user_id) === String(state.userId);
    var mediaCount = Array.isArray(post.media_urls) ? post.media_urls.length : 0;
    openModal(post.title || "Объявление",
      '<div class="small muted">' + esc(marketplaceTypeTitle(post.post_type)) + " · " +
      esc(post.specialization) + " · " + esc(post.city) +
      (post.available_from ? " · с " + esc(String(post.available_from).slice(0, 10)) : "") +
      " · вложений: " + mediaCount + "</div>" +
      '<div class="mt-8">' + marketplaceGalleryHtml(post) + "</div>" +
      (String(post.budget_text || "").trim()
        ? '<div class="mt-16" style="font-weight:800;font-size:17px;color:#1F497D;">' +
          esc(post.budget_text) + "</div>" : "") +
      (String(post.volume_desc || "").trim()
        ? '<p class="mt-8">' + esc(post.volume_desc) + "</p>" : "") +
      '<div class="small muted mt-8">Контакт: ' + esc(post.contact_name) + " · " +
      esc(post.contact_phone) + " · опубликовано " + esc(fmtDate(post.created_at)) + "</div>" +
      '<div class="flex mt-16">' + contactButtonsHtml(post.contact_phone) +
      (mine ? '<button class="btn btn-outline btn-sm" id="detail-archive" type="button">Снять с публикации</button>' +
        '<button class="btn btn-danger btn-sm" id="detail-delete" type="button">Удалить</button>' : "") +
      (state.isSuper ? '<button class="btn btn-danger btn-sm" id="detail-delete-admin" type="button">Удалить (Админ)</button>' : "") +
      "</div>");
    bindMaxButtons($("#modal-body"));
    var archiveBtn = $("#detail-archive");
    if (archiveBtn) archiveBtn.addEventListener("click", function () { archiveMarketplacePost(post.id); });
    var deleteBtn = $("#detail-delete");
    if (deleteBtn) deleteBtn.addEventListener("click", function () { deleteMarketplacePost(post.id); });
    var adminBtn = $("#detail-delete-admin");
    if (adminBtn) adminBtn.addEventListener("click", function () { deleteMarketplacePost(post.id); });
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
    state.contractorsTab = "board";
    renderRoute();
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



  async function renderMarketplaceBoard(root) {
    root.innerHTML = '<div class="muted">Загрузка биржи подрядов…</div>';
    var res = await sb.from("marketplace_posts")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(200);
    if (res.error) {
      root.innerHTML = contractorsTabs("board") +
        '<div class="warn-box mt-16">Не удалось прочитать биржу: ' + esc(res.error.message) + "</div>";
      bindContractorsTabs(root);
      return;
    }
    var rows = res.data || [];
    state.marketplacePosts = rows;
    var filters = state.marketplaceFilters || (state.marketplaceFilters = { city: "", spec: "", type: "" });
    var specs = {};
    rows.forEach(function (row) { if (row.specialization) specs[row.specialization] = true; });

    root.innerHTML = contractorsTabs("board") +
      '<div class="flex-between mt-16"><div><h2 class="section-title" style="margin:0;">Биржа подрядов</h2>' +
      '<p class="section-sub" style="margin:4px 0 0;">Общая доска по регионам: «ищу подрядчика» и «бригада свободна». ' +
      "Лимит активных объявлений зависит от тарифа организации.</p></div>" +
      '<button class="btn btn-navy" id="post-add" type="button">Опубликовать объявление</button></div>' +
      '<div class="form-row mt-16">' +
      '<label class="field"><span>Город</span><input type="text" id="mp-city" value="' + esc(filters.city) + '" placeholder="Москва" /></label>' +
      '<label class="field"><span>Специализация</span><select id="mp-spec"><option value="">Все виды работ</option>' +
      Object.keys(specs).sort().map(function (item) {
        return '<option value="' + esc(item) + '"' + (filters.spec === item ? " selected" : "") + ">" + esc(item) + "</option>";
      }).join("") + "</select></label>" +
      '<label class="field"><span>Тип объявления</span><select id="mp-type">' +
      '<option value="">Все типы</option>' +
      '<option value="need_contractor"' + (filters.type === "need_contractor" ? " selected" : "") + ">Ищу подрядчика на объём</option>" +
      '<option value="brigade_available"' + (filters.type === "brigade_available" ? " selected" : "") + ">Бригада ищет объём</option>" +
      "</select></label></div>" +
      '<div class="mt-16" id="mp-list">' + marketplaceCardsHtml(rows, filters) + "</div>";

    bindContractorsTabs(root);
    function refresh() {
      $("#mp-list").innerHTML = marketplaceCardsHtml(state.marketplacePosts, filters);
      bindPostActions(root);
    }
    $("#mp-city").addEventListener("input", function () { filters.city = $("#mp-city").value.trim(); refresh(); });
    $("#mp-spec").addEventListener("change", function () { filters.spec = $("#mp-spec").value; refresh(); });
    $("#mp-type").addEventListener("change", function () { filters.type = $("#mp-type").value; refresh(); });
    $("#post-add").addEventListener("click", openMarketplaceModal);
    bindPostActions(root);
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
          : "") +
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
      root.innerHTML = contractorsTabs("board") +
        '<div class="warn-box mt-16">Не удалось прочитать биржу: ' + esc(res.error.message) + "</div>";
      bindContractorsTabs(root);
      return;
    }
    var rows = res.data || [];
    state.marketplacePosts = rows;
    var filters = state.marketplaceFilters || (state.marketplaceFilters = {
      city: "", spec: "", type: "", onlyFavorites: false,
    });
    var specs = {};
    rows.forEach(function (row) { if (row.specialization) specs[row.specialization] = true; });

    root.innerHTML = contractorsTabs("board") +
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

    bindContractorsTabs(root);
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

  /// Список объектов организации (1-в-1 с приложением, без фантомных записей).
  async function loadProjectsList() {
    state.projects = [];
    if (!state.orgId) return [];
    var res = await sb.from("projects")
      .select("id, name, city, address, status, camera_stream_url, cover_path, budget, created_at, " +
        "contract_number, contract_date, investor_name, customer_name, customer_inn, " +
        "contractor_name, contractor_inn, vat_rate")
      .eq("organization_id", state.orgId)
      .order("created_at", { ascending: false });
    if (res.error) {
      console.warn("[objects]", res.error.message);
      return [];
    }
    state.projects = res.data || [];
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
      return (res && res.data && res.data.publicUrl) || "";
    } catch (e) {
      return "";
    }
  }

  /// Компактная «пилюля» активного объекта для всех внутренних разделов.
  function objectSwitcherHtml() {
    var project = activeProject();
    var cover = objectCoverUrl(project);
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
      var cover = objectCoverUrl(project);
      var active = num(project.id) === num(state.activeProjectId);
      return '<div class="calc-row mt-8" data-pick="' + esc(project.id) + '">' +
        '<div class="cr-icon">' + (cover
          ? '<img src="' + esc(cover) + '" style="width:30px;height:30px;border-radius:8px;object-fit:cover;" alt="" />'
          : "🏗") + "</div>" +
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
        : '<div class="warn-box mt-16">Объектов пока нет. Создайте первый — он появится и на телефоне, ' +
          "и на сайте у всех сотрудников организации.</div>");
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
    var cover = objectCoverUrl(project);
    var camera = String(project.camera_stream_url || "").trim();
    var address = [project.city, project.address].filter(function (v) {
      return String(v || "").trim();
    }).join(", ");
    return '<div class="object-card">' +
      '<div class="oc-cover">' + (cover
        ? '<img src="' + esc(cover) + '" alt="" />'
        : "🏗") + "</div>" +
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
    if (!(state.projects || []).length) await loadProjectsList();
    var project = (state.projects || []).filter(function (p) {
      return String(p.id) === String(projectId);
    })[0] || null;
    if (!project) {
      root.innerHTML = '<div class="warn-box">Объект не найден или недоступен этой организации. ' +
        '<a href="#/cabinet/objects">Вернуться к списку объектов</a></div>';
      return;
    }
    setActiveProject(project.id);
    var cover = objectCoverUrl(project);
    var camera = String(project.camera_stream_url || "").trim();
    var mediaRes = await sb.from("project_media").select("*")
      .eq("project_id", num(project.id))
      .eq("organization_id", state.orgId)
      .order("id", { ascending: false }).limit(24);
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
      '<div class="card"><div class="oc-cover" style="border-radius:12px;">' + (cover
        ? '<img src="' + esc(cover) + '" alt="" />' : "🏗") + "</div>" +
      '<p class="small muted mt-8">Обложка хранится в общем облаке организации и видна всем сотрудникам ' +
      "и на сайте.</p></div>" +
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
      '<div class="card mt-16"><div class="flex-between"><h3 style="margin:0;">LIVE-камера объекта</h3>' +
      '<button class="btn btn-outline btn-sm" id="obj-camera" type="button">' +
      (camera ? "Изменить ссылку" : "Добавить камеру") + "</button></div>" +
      (camera ? cameraBlock(camera) :
        '<p class="small muted mt-8">Ссылка на поток не задана. Добавьте её — поток появится и в приложении, ' +
        "и на сайте.</p>") + "</div>" +
      '<div class="card mt-16"><div class="flex-between"><h3 style="margin:0;">Фотоотчёт объекта</h3>' +
      '<label class="btn btn-navy btn-sm" for="obj-photo" style="cursor:pointer;">+ Добавить фото</label>' +
      '<input id="obj-photo" type="file" accept="image/*" class="hidden" multiple /></div>' +
      (gallery ? '<div class="objects-grid mt-16" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));">' +
        gallery + "</div>" :
        '<p class="small muted mt-8">Фотографий пока нет — добавьте первые кадры с площадки.</p>') + "</div>";
    mountObjectSwitcher();
    var editBtn = $("#obj-edit");
    if (editBtn) editBtn.addEventListener("click", function () { openObjectEditor(project); });
    var coverBtn = $("#obj-cover");
    if (coverBtn) coverBtn.addEventListener("click", function () { pickObjectCover(project.id); });
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
        var current = data.vat_rate == null ? 20 : num(data.vat_rate);
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

  async function uploadObjectCover(projectId, file) {
    var id = num(projectId);
    if (!id || !state.orgId) { toast("Объект или организация не определены"); return; }
    var path = state.orgId + "/" + id + ".jpg";
    try {
      var up = await sb.storage.from(OBJECT_COVER_BUCKET)
        .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
      if (up.error) { toast("Не удалось загрузить обложку: " + up.error.message, 7000); return; }
      var upd = await sb.from("projects")
        .update({ cover_path: path, cover_updated_at: new Date().toISOString() })
        .eq("id", id);
      if (upd.error) { toast("Файл загружен, но путь не сохранён: " + upd.error.message, 7000); return; }
      toast("Обложка обновлена — её видят все сотрудники организации");
      await loadProjectsList();
      renderRoute();
    } catch (e) {
      toast("Ошибка загрузки обложки: " + e, 7000);
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

  /// Удаление объекта организации (RLS projects_delete_org).
  async function deleteObject(projectId) {
    var id = num(projectId);
    if (!id) return;
    if (!window.confirm("Удалить объект? Сметы и расчёты останутся в архиве организации.")) return;
    var res = await sb.from("projects").delete().eq("id", id);
    if (res.error) {
      toast("Объект не удалён: " + res.error.message, 8000);
      return;
    }
    try {
      await sb.storage.from(OBJECT_COVER_BUCKET).remove([state.orgId + "/" + id + ".jpg"]);
    } catch (e) { /* обложки могло не быть */ }
    toast("Объект удалён");
    await loadProjectsList();
    renderRoute();
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
    root.innerHTML = wsHeaderHtml() + wsTabsHtml() + '<div id="ws-body" class="mt-16"></div>';
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

  function wsWorksHtml() {
    var works = wsItems("work");
    if (!works.length) {
      return '<div class="card"><p class="small muted">Работы не загружены. ' +
        "Загрузите позиции из сметы в приложении (ГПР — КС-2 / КС-3 → «Рабочая смета»).</p></div>";
    }
    return '<div class="table-wrap" style="max-height:60vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th>№</th><th>Наименование работ</th><th>Раздел</th>' +
      '<th>Ед.</th><th class="num">План</th><th class="num">Выполнено</th><th class="num">Сумма работ, ₽</th>' +
      "</tr></thead><tbody>" + works.map(function (item, index) {
        var done = wsNum(item.completed_qty);
        var price = wsNum(item.unit_price_client);
        return "<tr><td>" + (index + 1) + "</td>" +
          "<td>" + esc(item.name || "") + "</td>" +
          '<td class="small muted">' + esc(item.section_name || "—") + "</td>" +
          "<td>" + esc(item.unit || "") + "</td>" +
          '<td class="num">' + wsNum(item.plan_qty) + "</td>" +
          '<td class="num">' + done + "</td>" +
          '<td class="num">' + money(done * price) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function wsMaterialsHtml() {
    var materials = wsItems("material");
    if (!materials.length) {
      return '<div class="card"><p class="small muted">Материалы не загружены. ' +
        "Импорт позиций из сметы доступен в приложении (Рабочая смета → «Загрузить из сметы / ПД»).</p></div>";
    }
    var selectedCount = Object.keys(state.wsSelected || {}).length;
    return '<div class="flex-between mt-8"><div class="small muted">Отмечено к закупке: ' +
      selectedCount + "</div>" +
      '<button class="btn btn-navy btn-sm" id="ws-order" type="button"' +
      (selectedCount ? "" : " disabled") + ">Заказать остаток (" + selectedCount + ")</button></div>" +
      '<div class="table-wrap mt-8" style="max-height:58vh;overflow:auto;">' +
      '<table class="data"><thead><tr><th></th><th>Материал</th><th>Ед.</th>' +
      '<th class="num">План</th><th class="num">Куплено</th><th class="num">Использовано</th>' +
      '<th class="num">Докупить</th><th></th></tr></thead><tbody>' +
      materials.map(function (item) {
        var id = String(item.id);
        var toBuy = wsToBuy(item);
        var checked = state.wsSelected && state.wsSelected[id] != null;
        return "<tr><td><input type=\"checkbox\" data-ws-pick=\"" + esc(id) + "\"" +
          (checked ? " checked" : "") + " /></td>" +
          "<td>" + esc(item.name || "") + "</td>" +
          "<td>" + esc(item.unit || "") + "</td>" +
          '<td class="num">' + wsNum(item.plan_qty) + "</td>" +
          '<td class="num">' + wsNum(item.purchased_qty) + "</td>" +
          '<td class="num"><a href="#" data-ws-used="' + esc(id) + '">' + wsNum(item.used_qty) + "</a></td>" +
          '<td class="num" style="' + (toBuy > 0 ? "color:#B91C1C;font-weight:700;" : "") + '">' + toBuy + "</td>" +
          '<td><button class="btn btn-outline btn-sm" type="button" data-ws-buy="' + esc(id) + '">Купить</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  // ── обработчики вкладки «Материалы» ──
  function wsBindMaterials() {
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
    if (path === "" || path === "/") { renderLanding(root); return; }
    if (path === "/legal") { renderLegal(root); return; }
    if (path === "/cabinet") { renderCabinet(root); return; }
    if (path === "/cabinet/objects") { renderObjects(root); return; }
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
    if (partnersBtn) partnersBtn.addEventListener("click", openPartnerApplyModal);
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
      state.profile = null;
      state.userId = null;
      state.userEmail = "";
      state.orgName = "";
      state.isSuper = false;
      renderSessionBadge();
      toast("Вы вышли из кабинета");
      location.hash = "#/";
    });
    var releaseNode = $("#release-tag");
    if (releaseNode) releaseNode.textContent = "Релиз " + (CFG.release || "");

    sb.auth.onAuthStateChange(function () { setTimeout(loadSession, 0); });
    window.addEventListener("hashchange", renderRoute);
    loadSession();
  }

  async function loadSession() {
    await loadProfile();
    renderSessionBadge();
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












