import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/util/markdown-lite";

describe("markdown-lite (model replies → data, never HTML)", () => {
  it("parses headings, lists, code fences, quotes, rules and paragraphs", () => {
    const b = parseMarkdown("# Title\n\nIntro **bold** and `x()`.\n\n- one\n- two\n  continued\n\n1. first\n2) second\n\n```ts\nconst a = 1;\n```\n> quoted\n> more\n\n---\nend");
    expect(b.map((x) => x.t)).toEqual(["heading", "para", "list", "list", "code", "quote", "rule", "para"]);
    expect(b[0]).toEqual({ t: "heading", level: 1, c: [{ t: "text", v: "Title" }] });
    expect(b[1]).toEqual({ t: "para", c: [{ t: "text", v: "Intro " }, { t: "strong", c: [{ t: "text", v: "bold" }] }, { t: "text", v: " and " }, { t: "code", v: "x()" }, { t: "text", v: "." }] });
    expect(b[2]).toMatchObject({ ordered: false, items: [[{ t: "text", v: "one" }], [{ t: "text", v: "two" }, { t: "text", v: " " }, { t: "text", v: "continued" }]] });
    expect(b[3]).toMatchObject({ ordered: true }); expect((b[3] as any).items).toHaveLength(2);
    expect(b[4]).toEqual({ t: "code", lang: "ts", v: "const a = 1;" });
    expect(b[5]).toEqual({ t: "quote", c: [{ t: "text", v: "quoted\nmore" }] });
  });
  it("keeps markup inside code literal and leaves an unclosed fence open (streaming)", () => {
    expect(parseMarkdown("```\n**not bold** <b>x</b>")).toEqual([{ t: "code", lang: undefined, v: "**not bold** <b>x</b>" }]);
    expect(parseInline("`**x**`")).toEqual([{ t: "code", v: "**x**" }]);
  });
  it("only links safe targets; javascript:/data: links keep just their label", () => {
    expect(parseInline("[docs](https://a.test/x) [bad](javascript:alert(1)) [d](data:text/html,x)")).toEqual([
      { t: "link", href: "https://a.test/x", c: [{ t: "text", v: "docs" }] }, { t: "text", v: " bad) d" },
    ]);
  });
  it("does not treat snake_case or arithmetic as emphasis", () => {
    expect(parseInline("call get_user_name and 2 * 3 * 4")).toEqual([{ t: "text", v: "call get_user_name and 2 * 3 * 4" }]);
    expect(parseInline("an *emphasis* and _also_")).toEqual([{ t: "text", v: "an " }, { t: "em", c: [{ t: "text", v: "emphasis" }] }, { t: "text", v: " and " }, { t: "em", c: [{ t: "text", v: "also" }] }]);
  });
  it("raw HTML stays text", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([{ t: "para", c: [{ t: "text", v: "<img src=x onerror=alert(1)>" }] }]);
  });
});
