import { readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../../client/messages/", import.meta.url);
const messages = [
  "Event type",
  "Cohorts",
  "Search cohorts",
  "No cohorts yet",
  "Cohort actions",
  "Remove event type filter",
  "Remove bounce filter",
];
const translations = {
  cs: [
    "Typ události",
    "Kohorty",
    "Hledat kohorty",
    "Zatím žádné kohorty",
    "Akce kohorty",
    "Odebrat filtr typu události",
    "Odebrat filtr okamžitého opuštění",
  ],
  de: [
    "Ereignistyp",
    "Kohorten",
    "Kohorten suchen",
    "Noch keine Kohorten",
    "Kohortenaktionen",
    "Ereignistypfilter entfernen",
    "Absprungfilter entfernen",
  ],
  es: [
    "Tipo de evento",
    "Cohortes",
    "Buscar cohortes",
    "Aún no hay cohortes",
    "Acciones de cohorte",
    "Quitar filtro de tipo de evento",
    "Quitar filtro de rebote",
  ],
  fr: [
    "Type d’événement",
    "Cohortes",
    "Rechercher des cohortes",
    "Aucune cohorte pour le moment",
    "Actions de la cohorte",
    "Supprimer le filtre de type d’événement",
    "Supprimer le filtre de rebond",
  ],
  it: [
    "Tipo di evento",
    "Coorti",
    "Cerca coorti",
    "Nessuna coorte",
    "Azioni della coorte",
    "Rimuovi filtro del tipo di evento",
    "Rimuovi filtro dei rimbalzi",
  ],
  ja: [
    "イベントの種類",
    "コホート",
    "コホートを検索",
    "コホートはまだありません",
    "コホートの操作",
    "イベント種類のフィルターを削除",
    "直帰フィルターを削除",
  ],
  ko: [
    "이벤트 유형",
    "코호트",
    "코호트 검색",
    "아직 코호트가 없습니다",
    "코호트 작업",
    "이벤트 유형 필터 제거",
    "이탈 필터 제거",
  ],
  pl: [
    "Typ zdarzenia",
    "Kohorty",
    "Szukaj kohort",
    "Brak kohort",
    "Działania kohorty",
    "Usuń filtr typu zdarzenia",
    "Usuń filtr odrzuceń",
  ],
  pt: [
    "Tipo de evento",
    "Coortes",
    "Pesquisar coortes",
    "Ainda não há coortes",
    "Ações da coorte",
    "Remover filtro de tipo de evento",
    "Remover filtro de rejeição",
  ],
  uk: [
    "Тип події",
    "Когорти",
    "Пошук когорт",
    "Когорт ще немає",
    "Дії з когортою",
    "Видалити фільтр типу події",
    "Видалити фільтр відмов",
  ],
  zh: ["事件类型", "同期群", "搜索同期群", "暂无同期群", "同期群操作", "移除事件类型筛选", "移除跳出筛选"],
};
const english = JSON.parse(readFileSync(new URL("en.json", directory), "utf8"));
const keys = messages.map(message => Object.keys(english).find(key => english[key] === message));
if (keys.some(key => !key)) throw new Error("Extract the messages first");
for (const [locale, values] of Object.entries(translations)) {
  const path = new URL(`${locale}.json`, directory);
  const current = JSON.parse(readFileSync(path, "utf8"));
  keys.forEach((key, index) => {
    current[key] = values[index];
  });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}
console.log(`Translated ${messages.length} messages in ${Object.keys(translations).length} locales`);
