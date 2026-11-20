// V192.0 (ТЗ §1.4): публичная конфигурация портала neyroplan.ru.
// Здесь ТОЛЬКО публичные значения (anon key предназначен для браузера).
// Service-role ключи и любые секреты в статический портал не попадают никогда.
window.NEYROPLAN_CONFIG = {
  supabaseUrl: "https://phmxhzkagdsdqwldyheu.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBobXhoemthZ2RzZHF3bGR5aGV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MzU0MzIsImV4cCI6MjEwNzIxMTQzMn0.LKQZKVcH0zaSOOs5xOSY86gneYSZnP5HBzZMb7lJPCs",
  qrFunction: "qr-auth",
  // V192.7: шлюз регистрации (проверка ИНН через DaData, инвайты, согласия 152-ФЗ).
  registrationFunction: "registration-gateway",
  release: "V194.5",
  // V193.3: необязательный счётчик Яндекс.Метрики (пусто = скрипт не грузится).
  YANDEX_METRIKA_ID: "",
  siteName: "НейроПлан",
  domains: ["neyroplan.ru", "www.neyroplan.ru", "нейроплан.рф"],
  // Мониторинг бэкенда для защищённого раздела /admin.
  engineHealthUrl: "https://stroy-app-p1b1.onrender.com/health",
  engineProvidersUrl: "https://stroy-app-p1b1.onrender.com/billing/providers",
  // V192.0 (ТЗ §4): URL проектного воркера — используется для мгновенного
  // пробуждения контейнера (fire-and-forget ping) в момент постановки задачи.
  projectWorkerUrl: "https://neuroplan-project-worker.onrender.com",
  projectWorkerHealthUrl: "https://neuroplan-project-worker.onrender.com/health",
};
