import { describe, expect, it } from "vitest";
import { investigateSource } from "@omniforge/core";
import { nodeStructureExtractor } from "../src/node";

const ex = nodeStructureExtractor();
const one = async (path: string, content: string) => (await ex.extract([{ path, content }])).files[0]!;
const routes = (f: { routes: { method: string; path: string; handler?: string }[] }) => f.routes.map((r) => `${r.method} ${r.path}`);
const syms = (f: { symbols: { name: string; kind: string; container?: string }[] }) => f.symbols.map((s) => `${s.kind}:${s.container ? s.container + "." : ""}${s.name}`);

const PY = `from fastapi import FastAPI, APIRouter
import os
from flask import Blueprint
app = FastAPI()
router = APIRouter()
bp = Blueprint("x", __name__)

@app.get("/users/{user_id}")
def get_user(user_id: int):
    return 1

@router.post("/items")
async def create_item():
    pass

@bp.route("/legacy", methods=["POST", "PUT"])
def legacy(): pass

@bp.route("/plain")
def plain(): pass

@app.get(f"/dyn/{os.sep}")
def dyn(): pass

@app.get("not-absolute")
def na(): pass

class Service:
    def run(self): pass
`;
describe("Python", () => {
  it("finds FastAPI/Flask routes (static paths only), symbols and imports", async () => {
    const f = await one("app/main.py", PY);
    expect(routes(f)).toEqual(["GET /users/{user_id}", "POST /items", "POST /legacy", "PUT /legacy", "GET /plain"]); // f-string and non-absolute paths are NOT guessed at
    expect(f.routes.find((r) => r.path === "/items")!.handler).toBe("create_item");
    expect(syms(f)).toEqual(["function:get_user", "function:create_item", "function:legacy", "function:plain", "function:dyn", "function:na", "class:Service", "method:Service.run"]);
    expect(f.imports).toEqual(["fastapi", "os", "flask"]);
    expect(f.symbols[0]).toMatchObject({ file: "app/main.py", line: 9, language: "Python" });
  });
  it("reads Django urlpatterns only from urls.py", async () => {
    const src = `from django.urls import path\nurlpatterns = [path("admin/", admin.site.urls), path("api/users/<int:pk>/", views.user)]\n`;
    expect(routes(await one("shop/urls.py", src))).toEqual(["ANY /admin/", "ANY /api/users/<int:pk>/"]);
    expect(routes(await one("shop/other.py", src))).toEqual([]);
  });
});

describe("JavaScript / TypeScript", () => {
  it("finds server routes but not client calls, with symbols and imports", async () => {
    const src = `import express from "express";
import { z } from "zod";
const fs = require("fs");
const app = express();
app.get("/api/items", listItems);
app.post("/api/items", (req, res) => res.json({}));
router.delete("/api/items/:id", auth, remove);
app.all("/any", handler);
axios.get("/api/client-call", { params: {} });
fetchJson.get("/api/one-arg");
app.get("/api/dyn/" + id, h);
cache.get("key", h);
export class Cart { add() {} }
export function checkout() {}
const f = async () => 1;
interface Props {}
type T = string;
enum E { A }
`;
    const f = await one("src/server.ts", src);
    expect(routes(f)).toEqual(["GET /api/items", "POST /api/items", "DELETE /api/items/:id", "ANY /any"]);
    expect(f.routes[0]!.handler).toBe("listItems");
    expect(syms(f)).toEqual(["class:Cart", "method:Cart.add", "function:checkout", "function:f", "interface:Props", "type:T", "enum:E"]);
    expect(f.imports).toEqual(["express", "zod", "fs"]);
  });
  it("parses TSX and JSX files", async () => {
    expect(syms(await one("a.tsx", "export function App() { return <div/>; }"))).toEqual(["function:App"]);
    expect(syms(await one("a.jsx", "export const B = () => <p/>;"))).toEqual(["function:B"]);
  });
});

describe("Go", () => {
  it("finds gin/net-http routes (incl. Go 1.22 'METHOD /path' patterns), types and methods", async () => {
    const src = `package main
import (
  "net/http"
  "github.com/gin-gonic/gin"
)
func main() {
  r := gin.Default()
  r.GET("/ping", ping)
  r.POST("/users/:id", createUser)
  http.HandleFunc("/health", health)
  mux.HandleFunc("GET /v2/items/{id}", getItem)
  client.Get("/not-a-route")
  http.Get("https://example.com")
}
type Srv struct{}
type Store interface{ Get() }
type ID string
func (s *Srv) Run() {}
func helper() {}
`;
    const f = await one("cmd/main.go", src);
    expect(routes(f)).toEqual(["GET /ping", "POST /users/:id", "ANY /health", "GET /v2/items/{id}"]);
    expect(f.imports).toEqual(["net/http", "github.com/gin-gonic/gin"]);
    expect(syms(f)).toEqual(["function:main", "struct:Srv", "interface:Store", "type:ID", "method:Srv.Run", "function:helper"]);
  });
});

describe("Java (Spring)", () => {
  it("combines the class-level @RequestMapping prefix with method mappings", async () => {
    const src = `import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class UserController {
  @GetMapping("/users/{id}") public User get(@PathVariable long id) { return null; }
  @PostMapping public User create() { return null; }
  @RequestMapping(value = "/old", method = RequestMethod.POST) public void old() {}
  @DeleteMapping({"/a", "/b"}) public void del() {}
}
`;
    const f = await one("src/UserController.java", src);
    expect(routes(f)).toEqual(["GET /api/users/{id}", "POST /api", "POST /api/old", "DELETE /api/a", "DELETE /api/b"]);
    expect(f.imports).toEqual(["org.springframework.web.bind.annotation"]);
    expect(syms(f)).toEqual(["class:UserController", "method:UserController.get", "method:UserController.create", "method:UserController.old", "method:UserController.del"]);
  });
});

describe("Rust", () => {
  it("finds axum .route() chains and actix attribute macros", async () => {
    const src = `use axum::{routing::get, Router};
fn app() -> Router { Router::new().route("/items", get(list).post(create)).route("/items/:id", get(show)) }
#[get("/ping")]
async fn ping() {}
#[post("/submit")]
async fn submit() {}
struct S;
enum E { A }
trait T { fn t(&self); }
impl S { fn m(&self) {} }
`;
    const f = await one("src/main.rs", src);
    expect(routes(f)).toEqual(["GET /items", "POST /items", "GET /items/:id", "GET /ping", "POST /submit"]); // source order, one entry per verb
    expect(f.routes.filter((r) => r.path === "/items").map((r) => r.handler)).toEqual(["list", "create"]); // each verb keeps its own handler
    expect(f.routes.find((r) => r.path === "/ping")!.handler).toBe("ping");
    expect(syms(f)).toEqual(["function:app", "function:ping", "function:submit", "struct:S", "enum:E", "trait:T", "method:S.m"]);
  });
});

describe("C# (ASP.NET Core)", () => {
  it("resolves [controller] prefixes, absolute overrides and minimal-API Map* calls", async () => {
    const src = `using Microsoft.AspNetCore.Mvc;
[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase {
  [HttpGet("{id}")] public IActionResult Get(int id) => Ok();
  [HttpPost] public IActionResult Create() => Ok();
  [HttpGet("/absolute")] public IActionResult Abs() => Ok();
}
var app = builder.Build();
app.MapGet("/health", () => "ok");
app.MapPost("items", () => 1);
`;
    const f = await one("Controllers/OrdersController.cs", src);
    expect(routes(f)).toEqual(["GET /api/orders/{id}", "POST /api/orders", "GET /absolute", "GET /health", "POST /items"]);
    expect(syms(f)).toEqual(["class:OrdersController", "method:OrdersController.Get", "method:OrdersController.Create", "method:OrdersController.Abs"]);
  });
});

describe("extractor behaviour", () => {
  it("counts unsupported languages instead of guessing, tolerates syntax errors, and skips oversized files", async () => {
    const r = await ex.extract([{ path: "a.rb", content: "puts 1" }, { path: "b.py", content: "def (((:\n  x" }, { path: "c.py", content: "# " + "x".repeat(400_001) }, { path: "README.md", content: "# hi" }]);
    expect(r.unsupported).toBe(1); expect(r.failed).toEqual([]); expect(r.parsed).toBe(1);
  });
  it("stops when aborted", async () => {
    const ctl = new AbortController(); ctl.abort();
    expect((await ex.extract([{ path: "a.py", content: "def f(): pass" }], { signal: ctl.signal })).parsed).toBe(0);
  });
});

describe("in an investigation", () => {
  const input = (path: string, text: string) => ({ path, data: new TextEncoder().encode(text) });
  const files = [input("api/main.py", PY), input("web/server.ts", `import express from "express"; const app = express(); app.get("/api/items", list);`), input("README.md", "# demo")];
  it("adds parsed routes as recovered endpoints, a feature, symbols and a coverage check", async () => {
    const inv = await investigateSource("demo", files, { kind: "files", structure: ex });
    expect(inv.endpoints.filter((e) => /^(api|web)\//.test(e.foundIn)).map((e) => `${e.method} ${e.url}`).sort()).toEqual(["GET /api/items", "GET /plain", "GET /users/{user_id}", "POST /items", "POST /legacy", "PUT /legacy"]);
    const e = inv.endpoints.find((x) => x.url === "/users/{user_id}")!;
    expect(e.foundIn).toBe("api/main.py:8"); // the decorator line, where the route is declared
    expect(inv.evidence.find((v) => v.id === e.evidence)).toMatchObject({ kind: "recovered", method: "tree-sitter" });
    expect(inv.features.some((f) => /HTTP API surface/.test(f.name))).toBe(true);
    expect(inv.symbols!.some((s) => s.name === "create_item" && s.language === "Python")).toBe(true);
    expect(inv.routes!.some((r) => r.via === "code" && r.route === "/items")).toBe(true);
    expect(inv.coverage.checks.find((c) => c.id === "structure")).toMatchObject({ status: "done" });
  });
  it("without a parser, Python source gets an honest 'unavailable' check (and no invented routes)", async () => {
    const inv = await investigateSource("demo", files, { kind: "files" });
    expect(inv.coverage.checks.find((c) => c.id === "structure")).toMatchObject({ status: "unavailable" });
    expect(inv.symbols).toBeUndefined();
    expect(inv.endpoints.some((e) => e.url === "/users/{user_id}")).toBe(false);
  });
});
