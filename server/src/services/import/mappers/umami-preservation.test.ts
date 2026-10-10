import { describe, expect, it } from "vitest";
import { UmamiImportMapper } from "./umami.js";

const visitor = "9e3779b1-3c6e-4362-8a4f-81b88c81f013";
const visit = "0910b12c-94dd-45ee-8e12-c1c14fc0c9d4";
const event = {
  session_id: visitor,
  hostname: "example.com",
  browser: "chrome",
  os: "Linux",
  device: "desktop",
  screen: "1920x1080",
  language: "en",
  country: "US",
  region: "US-CA",
  city: "",
  url_path: "/",
  url_query: "",
  referrer_path: "",
  referrer_domain: "",
  page_title: "",
  event_type: "2",
  event_name: "checkout",
  distinct_id: "",
  created_at: "2024-06-15 14:30:00",
};

describe("Umami migration preservation", () => {
  it("keeps event properties and separates a visitor from their visit", () => {
    const input = {
      ...event,
      visit_id: visit,
      source_created_at: "2024-06-15T14:30:00.569123Z",
      props_json: JSON.stringify({ Stage: "Purchase", amount: 19.5, paid: true, empty: null, list: [1, "two"] }),
    };
    const request = UmamiImportMapper.migrationEventKeyOnlySchema.parse(input);
    const [mapped] = UmamiImportMapper.transform([request], 1, "import");
    expect(mapped.session_id).toBe(visit);
    expect(mapped.user_id).toBe(visitor);
    expect(mapped.timestamp_ms).toBe("2024-06-15 14:30:00.569");
    expect(mapped.props).toEqual(JSON.parse(input.props_json));
  });

  it("still accepts CSV rows without the migration fields", () => {
    const [mapped] = UmamiImportMapper.transform([{ ...event, distinct_id: visitor }], 1, "import");
    expect(mapped.session_id).toBe(visitor);
    expect(mapped.props).toEqual({});
  });

  it("keeps referrer query strings supplied by the migration export", () => {
    const [mapped] = UmamiImportMapper.transform(
      [
        {
          ...event,
          referrer_domain: "search.example.org",
          referrer_path: "/search",
          referrer_query: "q=fabric",
        },
      ],
      1,
      "import"
    );
    expect(mapped.referrer).toBe("https://search.example.org/search?q=fabric");
  });

  it("rejects malformed property JSON rather than replacing it with an empty object", () => {
    for (const props_json of ["{broken", "[]", "null"]) {
      expect(UmamiImportMapper.transform([{ ...event, props_json }], 1, "import")).toEqual([]);
    }
  });
});
