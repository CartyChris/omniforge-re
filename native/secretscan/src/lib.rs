//! OmniForge RE secret-scan engine (WebAssembly).
//!
//! Finds candidate secrets for gitleaks-style rules: one Aho-Corasick pass finds which rule keywords occur (instead of one
//! substring search per keyword), then only those rules' regexes run, on Rust's linear-time `regex` engine. It reports raw
//! match and secret-group positions; entropy floors, allowlists and redaction stay in TypeScript, shared with the pure-JS
//! fallback, so both engines apply exactly the same policy.
//!
//! ABI (all integers little-endian u32, byte offsets into the UTF-8 input):
//! - `alloc(len) -> ptr`, `dealloc(ptr, len)`: buffers the host writes into.
//! - `init(ptr, len) -> failed`: rule table `[n] { [group] [re_len][re] [k] { [kw_len][kw] }* }*`. Returns how many rules did
//!   not compile; their indices are in the result buffer (the host runs those in JS).
//! - `scan(ptr, len) -> count`: result buffer holds `count` records `[rule, match_start, match_end, secret_start, secret_end]`.
//! - `out_ptr() -> ptr`: the result buffer.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use regex::bytes::{Regex, RegexBuilder};
use std::cell::RefCell;

pub struct Rule {
    re: Option<Regex>,
    /// 0 = first non-empty capture group (gitleaks' default), n = that group.
    group: usize,
    keywords: Vec<usize>,
}

pub struct Engine {
    rules: Vec<Rule>,
    ac: Option<AhoCorasick>,
    nkw: usize,
}

/// One candidate: rule index, whole match [start, end), secret [start, end) — byte offsets.
pub type Hit = [u32; 5];

impl Engine {
    /// `rules`: (pattern, secret group, lowercase keywords).
    pub fn new(rules: &[(String, usize, Vec<String>)]) -> (Engine, Vec<u32>) {
        let mut kws: Vec<String> = Vec::new();
        let mut failed = Vec::new();
        let mut out = Vec::with_capacity(rules.len());
        for (i, (re, group, keywords)) in rules.iter().enumerate() {
            let compiled = RegexBuilder::new(re).unicode(false).size_limit(64 << 20).dfa_size_limit(64 << 20).build().ok();
            if compiled.is_none() { failed.push(i as u32); }
            let ids = keywords.iter().map(|k| match kws.iter().position(|x| x == k) { Some(p) => p, None => { kws.push(k.clone()); kws.len() - 1 } }).collect();
            out.push(Rule { re: compiled, group: *group, keywords: ids });
        }
        let ac = if kws.is_empty() { None } else { AhoCorasickBuilder::new().ascii_case_insensitive(true).match_kind(MatchKind::Standard).build(&kws).ok() };
        (Engine { rules: out, ac, nkw: kws.len() }, failed)
    }

    pub fn scan(&self, text: &[u8]) -> Vec<Hit> {
        let mut present = vec![false; self.nkw];
        if let Some(ac) = &self.ac {
            let mut left = self.nkw;
            for m in ac.find_overlapping_iter(text) {
                let p = &mut present[m.pattern().as_usize()];
                if !*p { *p = true; left -= 1; if left == 0 { break; } }
            }
        }
        let mut hits = Vec::new();
        for (ri, rule) in self.rules.iter().enumerate() {
            let Some(re) = &rule.re else { continue };
            if !rule.keywords.is_empty() && !rule.keywords.iter().any(|&k| present[k]) { continue; }
            for caps in re.captures_iter(text) {
                let m = caps.get(0).unwrap();
                if m.start() == m.end() { continue; }
                let sec = if rule.group > 0 { caps.get(rule.group) } else { (1..caps.len()).filter_map(|g| caps.get(g)).find(|g| g.start() != g.end()) };
                let (ss, se) = match sec { Some(g) => (g.start(), g.end()), None if rule.group > 0 => continue, None => (m.start(), m.end()) };
                if ss == se { continue; }
                hits.push([ri as u32, m.start() as u32, m.end() as u32, ss as u32, se as u32]);
            }
        }
        hits
    }
}

struct Cursor<'a> { b: &'a [u8], at: usize }
impl Cursor<'_> {
    fn u32(&mut self) -> Option<u32> { let v = u32::from_le_bytes(self.b.get(self.at..self.at + 4)?.try_into().ok()?); self.at += 4; Some(v) }
    fn str(&mut self) -> Option<String> { let len = self.u32()? as usize; let s = std::str::from_utf8(self.b.get(self.at..self.at.checked_add(len)?)?).ok()?.to_owned(); self.at += len; Some(s) }
}

/// Parse the init table (see module docs). Returns None on a malformed or truncated buffer.
pub fn parse_rules(b: &[u8]) -> Option<Vec<(String, usize, Vec<String>)>> {
    let mut c = Cursor { b, at: 0 };
    let n = c.u32()? as usize;
    let mut rules = Vec::with_capacity(n.min(4096));
    for _ in 0..n {
        let group = c.u32()? as usize;
        let re = c.str()?;
        let k = c.u32()? as usize;
        let mut kws = Vec::with_capacity(k.min(64));
        for _ in 0..k { kws.push(c.str()?); }
        rules.push((re, group, kws));
    }
    Some(rules)
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(len.max(1)); let p = v.as_mut_ptr(); std::mem::forget(v); p }

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) { drop(Vec::from_raw_parts(ptr, 0, len.max(1))); }

/// # Safety
/// `ptr..ptr+len` must be a buffer the host wrote (from `alloc`).
#[no_mangle]
pub unsafe extern "C" fn init(ptr: *const u8, len: usize) -> i32 {
    let Some(rules) = parse_rules(std::slice::from_raw_parts(ptr, len)) else { return -1 };
    let (engine, failed) = Engine::new(&rules);
    let n = failed.len() as i32;
    OUT.with(|o| *o.borrow_mut() = failed);
    ENGINE.with(|e| *e.borrow_mut() = Some(engine));
    n
}

/// # Safety
/// `ptr..ptr+len` must be a buffer the host wrote (from `alloc`).
#[no_mangle]
pub unsafe extern "C" fn scan(ptr: *const u8, len: usize) -> i32 {
    let text = std::slice::from_raw_parts(ptr, len);
    ENGINE.with(|e| match &*e.borrow() {
        None => -1,
        Some(engine) => { let hits = engine.scan(text); let n = hits.len() as i32; OUT.with(|o| *o.borrow_mut() = hits.into_iter().flatten().collect()); n }
    })
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u32 { OUT.with(|o| o.borrow().as_ptr()) }

#[cfg(test)]
mod tests {
    use super::*;
    fn eng(rules: &[(&str, usize, &[&str])]) -> Engine { Engine::new(&rules.iter().map(|(r, g, k)| (r.to_string(), *g, k.iter().map(|s| s.to_string()).collect())).collect::<Vec<_>>()).0 }

    #[test]
    fn keyword_prefilter_and_secret_group() {
        let e = eng(&[(r"\b(hf_[a-zA-Z]{6})\b", 0, &["hf_"]), (r"tok=([0-9]+)", 0, &["tok="])]);
        let text = b"x HF_NOPE hf_abcdef y tok=123";
        let h = e.scan(text);
        assert_eq!(h, vec![[0, 10, 19, 10, 19], [1, 22, 29, 26, 29]]);
        // keyword absent → regex never runs (would match otherwise)
        assert!(eng(&[(r"[0-9]+", 0, &["zzz"])]).scan(b"123").is_empty());
        // keyword matching is ASCII case-insensitive, as the JS path lowercases the text
        assert_eq!(eng(&[(r"[0-9]+", 0, &["key"])]).scan(b"KEY 42").len(), 1);
    }

    #[test]
    fn explicit_group_empty_matches_and_bad_patterns() {
        let e = eng(&[(r"(a)?(b+)", 2, &[]), (r"x*", 0, &[])]);
        assert_eq!(e.scan(b"abb"), vec![[0, 0, 3, 1, 3]]); // empty x* matches are skipped
        let (_, failed) = Engine::new(&[("(".into(), 0, vec![]), ("ok".into(), 0, vec![])]);
        assert_eq!(failed, vec![0]);
    }

    #[test]
    fn abi_round_trip() {
        let mut buf = Vec::new();
        let put = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
        put(&mut buf, 1); put(&mut buf, 0); put(&mut buf, 3); buf.extend_from_slice(b"k=(");
        put(&mut buf, 0);
        let rules = parse_rules(&buf);
        assert_eq!(rules.unwrap(), vec![("k=(".to_string(), 0, vec![])]);
        assert!(parse_rules(&buf[..buf.len() - 1]).is_none()); // truncated → rejected, not read out of bounds
        unsafe { assert_eq!(init(buf.as_ptr(), buf.len()), 1); }
    }

    #[test]
    fn linear_time_on_pathological_input() {
        // A classic catastrophic-backtracking pattern for backtracking engines; Rust's regex stays linear.
        let e = eng(&[(r"(a+)+b", 0, &[])]);
        let text = vec![b'a'; 200_000];
        let t = std::time::Instant::now();
        assert!(e.scan(&text).is_empty());
        assert!(t.elapsed().as_millis() < 2_000, "took {:?}", t.elapsed());
    }
}
