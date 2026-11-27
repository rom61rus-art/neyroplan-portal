// V192.0 (ТЗ §1.4): публичная конфигурация портала neyroplan.ru.
// Здесь ТОЛЬКО публичные значения (anon key предназначен для браузера).
// Service-role ключи и любые секреты в статический портал не попадают никогда.
window.NEYROPLAN_CONFIG = {
  supabaseUrl: "https://db.neyroplan.ru",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzk1ODA2MDY5LCJleHAiOjE5NTM0ODYwNjl9.4fLfWfnHI1uNylPXNQZMJ5qRktVg7hxmnEz1mwneMIg",
  qrFunction: "qr-auth",
  // V192.7: шлюз регистрации (проверка ИНН через DaData, инвайты, согласия 152-ФЗ).
  registrationFunction: "registration-gateway",
  release: "V194.7.0",
  // V193.3: необязательный счётчик Яндекс.Метрики (пусто = скрипт не грузится).
  YANDEX_METRIKA_ID: "",
  siteName: "НейроПлан",
  domains: ["neyroplan.ru", "www.neyroplan.ru", "нейроплан.рф"],
  // Бэкенд-воркеры развёрнуты на VPS Hostkey: api.neyroplan.ru — сметный воркер,
  // project.neyroplan.ru — воркер ПД/РД (старые адреса Render выведены).
  // Мониторинг бэкенда для защищённого раздела /admin.
  engineHealthUrl: "https://api.neyroplan.ru/health",
  engineProvidersUrl: "https://api.neyroplan.ru/billing/providers",
  // V194.5.6-C (ТЗ §4): форма «Связаться с разработчиком» — SMTP воркера.
  supportUrl: "https://api.neyroplan.ru/api/support/contact",
  supportEmail: "neyroplan@mail.ru",
  supportTelegram: "https://t.me/neyroplan",
  // V192.0 (ТЗ §4): URL проектного воркера — используется для мгновенного
  // пробуждения контейнера (fire-and-forget ping) в момент постановки задачи.
  projectWorkerUrl: "https://project.neyroplan.ru",
  projectWorkerHealthUrl: "https://project.neyroplan.ru/health",
};
