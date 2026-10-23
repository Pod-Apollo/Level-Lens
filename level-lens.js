// ==UserScript==
// @name         Level Estimator
// @namespace    https://example.com/accessibility-tools
// @version      4.1.4
// @description  Page complexity review and planning with scope discovery, interaction inventory, effort estimates, and review guidance.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    "use strict";

    /*
     * Level Estimator is a page-complexity review and planning tool. Its main workflow is:
     * 1. Discover likely page sections so an evaluator can choose a scope.
     * 2. Inventory interactions and review signals within that scope.
     * 3. Estimate review effort and render a planning summary in an isolated panel.
     *
     * The estimates are planning signals, not an accessibility checker or
     * conformance test. A person decides what further review is appropriate.
     */

    /*
     * Code map
     * - State and DOM helpers: constants through firstHeading()
     * - Section discovery: label(), candidate(), and discover()
     * - Scope scan and effort estimates: scan()
     * - Report helpers and scope controls: priority() through startPicker()
     * - Report UI: render()
     * - Refresh, styles, and widget creation: refresh() through create()
     * - Keyboard/menu entry points and initial startup: toggle() and the final block
     *
     * Data flow: discover() fills regions and assessment; scan() builds the
     * selected-scope results; render() turns both into the visible report.
     * Changing scope or rescanning repeats the relevant steps.
     */
    const ID = "level-lens",
        STYLE = `${ID}-style`,
        HL = `${ID}-highlight`,
        PICK = `${ID}-pick`;
    let regions = [],
        assessment = {},
        active = "page",
        scanRoot = document,
        detail = "standard",
        notice = "",
        marked = [],
        clearMarksTimer = null,
        picker = null;

    // Phase 1: shared state and DOM helpers
    // These helpers normalize text and keep scans limited to visible page content.
    // $ returns a plain array; invalid selectors currently become empty results.
    const $ = (s, r = document) => {
        try {
            return [...r.querySelectorAll(s)];
        } catch (e) {
            return [];
        }
    },
        // uniq removes empty entries and duplicate elements while preserving order.
        uniq = (a) => [...new Set(a.filter(Boolean))],
        // norm gives labels consistent spacing; clamp bounds score-like values to 0-100.
        norm = (s) => (s || "").replace(/\s+/g, " ").trim(),
        clamp = (n) => Math.min(100, Math.max(0, n));
    // visible excludes the tool itself, hidden content, and elements without a rendered box.
    const visible = (e) =>
        e instanceof Element &&
        !e.closest(`#${ID}`) &&
        !e.hidden &&
        e.getAttribute("aria-hidden") !== "true" &&
        getComputedStyle(e).display !== "none" &&
        !/hidden|collapse/.test(getComputedStyle(e).visibility) &&
        !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    // scoped also includes the root element when it matches; querySelectorAll alone does not.
    const scoped = (s, r = scanRoot) =>
        uniq([...(r instanceof Element && r.matches(s) ? [r] : []), ...$(s, r)]).filter(visible);

    // Convert an ID-reference attribute (such as aria-labelledby) into readable text.
    function refs(e, a) {
        const v = e.getAttribute(a);
        return v
            ? norm(
                v
                    .split(/\s+/)
                    .map((id) => document.getElementById(id)?.textContent || "")
                    .join(" ")
            )
            : "";
    }

    // Resolve an element's likely accessible name using common HTML and ARIA sources.
    function accName(e) {
        const x = refs(e, "aria-labelledby") || norm(e.getAttribute("aria-label"));
        if (x) return x;
        if (e.labels) {
            const l = norm([...e.labels].map((x) => x.textContent).join(" "));
            if (l) return l;
        }
        for (const a of ["alt", "title"]) {
            const v = norm(e.getAttribute(a));
            if (v) return v;
        }
        const t = (e.getAttribute("type") || "").toLowerCase(),
            v = norm(e.getAttribute("value"));
        if (v && ["button", "submit", "reset"].includes(t)) return v;
        return norm(e.innerText || e.textContent);
    }
    // Treat generic framework IDs as weak labels; meaningful IDs can be turned into words.
    const meaningfulId = (id) =>
        !!id &&
        !/^(app|root|main|content|container|wrapper|page|site)$/i.test(id) &&
        !/^(div|section|module|block|item)[-_]?\d+$/i.test(id) &&
        id.replace(/[^a-z]/gi, "").length >= 4;
    // Convert identifier-style text into a readable fallback label.
    const humanize = (s) =>
        norm(s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/\b\w/g, (c) =>
            c.toUpperCase()
        );
    // Collect visible content used to decide whether a container is substantial.
    const content = (e) =>
        $(
            "h1,h2,h3,h4,h5,h6,[role=heading],p,li,img,canvas,table,form,button,a[href],input:not([type=hidden]),select,textarea,audio,video",
            e
        ).filter(visible);
    // Ignore mostly empty wrappers; keep containers with text and interactive content.
    const substantial = (e) =>
        content(e).length >= 2 ||
        (content(e).some((x) => x.matches("button,a[href],input,select,textarea")) &&
            norm(e.innerText).length > 20);
    // Return the first visible heading to label a discovered region.
    const firstHeading = (e) =>
        norm($("h1,h2,h3,h4,h5,h6,[role=heading]", e).find(visible)?.textContent);

    // Phase 2: discover useful page scopes
    // Give candidate sections a useful label and confidence score from available clues.
    // Label preference: landmark name, ARIA name, meaningful ID, heading, then visible text.
    function label(e, type) {
        if (type === "header") return "Header";
        if (type === "main") return "Main content";
        if (type === "footer") return "Footer";
        return (
            refs(e, "aria-labelledby") ||
            norm(e.getAttribute("aria-label")) ||
            (meaningfulId(e.id) ? humanize(e.id) : "") ||
            firstHeading(e) ||
            norm(e.innerText).slice(0, 70) ||
            `Unnamed ${e.tagName.toLowerCase()} region`
        );
    }
    // Ignore weak/empty candidates. The adjusted score records confidence evidence.
    function candidate(e, type, score, source, canonical = false) {
        if (!visible(e) || !substantial(e)) return null;
        const text = label(e, type);
        score = clamp(
            score +
            (firstHeading(e) ? 15 : 0) +
            (meaningfulId(e.id) ? 10 : 0) +
            (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") ? 15 : 0) -
            (/^Unnamed/.test(text) ? 20 : 0)
        );
        return {
            element: e,
            type,
            label: text,
            score,
            source,
            canonical,
            confidence: score >= 80 ? "high" : score >= 55 ? "medium" : "low",
            items: content(e),
        };
    }

    // Find canonical landmarks and likely section containers, then remove duplicates.
    // The resulting boundary score describes how useful the page structure may be for scoping.
    function discover() {
        const raw = [],
            first = (s) => $(s).find(visible),
            last = (s) => $(s).filter(visible).at(-1),
            header = first("body > header,[role=banner],header"),
            main = first("body > main,body > [role=main],main,[role=main]"),
            footer = last("body > footer,body > [role=contentinfo],footer,[role=contentinfo]");
        if (header) raw.push(candidate(header, "header", 100, "canonical header", true));
        if (main) raw.push(candidate(main, "main", 100, "canonical main", true));
        if (footer) raw.push(candidate(footer, "footer", 100, "canonical footer", true));
        // Gather explicit semantic regions and containers that identify themselves by name.
        $(
            "section,article,nav,aside,form,[role=region],[role=navigation],[role=complementary],[role=search],[role=form]"
        ).forEach((e) =>
            raw.push(
                candidate(
                    e,
                    e.matches("nav,[role=navigation]") ? "navigation" : "semantic",
                    e.matches("nav,[role=navigation],[role=region]") ? 75 : 60,
                    "semantic region"
                )
            )
        );
        $("div[id],section[id],article[id],div[aria-label],div[aria-labelledby]")
            .filter(
                (e) =>
                    meaningfulId(e.id) ||
                    e.getAttribute("aria-label") ||
                    e.getAttribute("aria-labelledby")
            )
            .forEach((e) => raw.push(candidate(e, "named", 60, "named container")));
        // A heading can reveal a useful container even when the page has no semantic region.
        $("h1,h2,h3,h4,h5,h6,[role=heading][aria-level]")
            .filter(visible)
            .forEach((h) => {
                let p = h.parentElement,
                    best = null,
                    n = 0;
                while (p && p !== document.body && n++ < 6) {
                    if (
                        /^(DIV|SECTION|ARTICLE|LI|ASIDE|FORM|MAIN)$/.test(p.tagName) &&
                        substantial(p)
                    ) {
                        let score =
                            (p.matches("section,article,aside,form") ? 30 : 0) +
                            (meaningfulId(p.id) ? 20 : 0) +
                            20;
                        if (!best || score > best.score) best = { p, score };
                    }
                    p = p.parentElement;
                }
                if (best) {
                    const c = candidate(
                        best.p,
                        "heading",
                        55 + Math.min(20, best.score / 4),
                        `visible ${h.tagName.toLowerCase()}`
                    );
                    if (c) {
                        c.label = norm(h.textContent).slice(0, 70);
                        raw.push(c);
                    }
                }
            });
        // Keep the strongest description per element, then remove near-identical scopes.
        // The smaller scope sets the overlap denominator, so near-identical nested scopes collapse.
        const exact = new Map();
        raw.filter(Boolean).forEach((c) => {
            const old = exact.get(c.element);
            if (!old || c.score > old.score) exact.set(c.element, c);
        });
        const kept = [];
        [...exact.values()]
            .sort((a, b) => +b.canonical - +a.canonical || b.score - a.score)
            .forEach((c) => {
                const dup = kept.find((k) => {
                    const A = new Set(c.items),
                        B = new Set(k.items),
                        small = Math.min(A.size, B.size);
                    if (!small) return false;
                    let shared = 0;
                    A.forEach((x) => {
                        if (B.has(x)) shared++;
                    });
                    return shared / small >= 0.9;
                });
                if (!dup || c.canonical) kept.push(c);
            });
        // Reserve one option for the whole page and mark any region nested inside another.
        regions = [
            {
                id: "page",
                element: document,
                type: "page",
                label: "Entire page",
                source: "document",
                confidence: "high",
                items: content(document.body),
            },
            ...kept.slice(0, 29),
        ];
        regions.forEach((r, i) => (r.id = i ? `region-${i}` : "page"));
        regions.forEach((r) => {
            if (!(r.element instanceof Element)) return;
            const parent = regions
                .filter(
                    (x) => x !== r && x.element instanceof Element && x.element.contains(r.element)
                )
                .sort((a, b) => a.items.length - b.items.length)[0];
            r.nested = !!parent;
        });
        // Score how many major headings are covered by distinct, reasonably named regions.
        const majors = $("h1,h2,h3").filter(visible),
            mapped = majors.filter((h) =>
                regions.some(
                    (r) =>
                        r.element instanceof Element &&
                        r.element.contains(h) &&
                        !["page", "main"].includes(r.type)
                )
            ).length,
            mainFound = regions.some((r) => r.type === "main"),
            canonical = ["header", "main", "footer"].filter((t) =>
                regions.some((r) => r.type === t)
            ).length,
            non = regions.slice(1),
            strong = non.filter((r) => r.confidence !== "low").length,
            distinct = new Set(non.map((r) => r.label.toLowerCase())).size;
        const score = Math.round(
            clamp(
                (mainFound ? 15 : 0) +
                (canonical / 3) * 10 +
                (majors.length ? (mapped / majors.length) * 30 : 21) +
                (non.length ? (strong / non.length) * 20 : 0) +
                (non.length ? (distinct / non.length) * 20 : 0) +
                5
            )
        ),
            rating = score >= 80 ? "CLEAR" : score >= 55 ? "MIXED" : "DIFFICULT";
        assessment = {
            score,
            rating,
            difficulty: 100 - score,
            mapped,
            total: majors.length,
            low: non.filter((r) => r.confidence === "low").length,
            description:
                rating === "CLEAR"
                    ? "Most major content areas were mapped to distinct, meaningfully named boundaries."
                    : rating === "MIXED"
                        ? "Useful boundaries were found, but some sections rely on inferred containers."
                        : "The page structure does not expose sufficiently distinct boundaries. Manual scope selection may be needed.",
        };
    }

    // Phase 3: scan the selected scope and estimate effort
    // Counts feed the planning estimates; they do not
    // determine whether a page passes an accessibility standard.
    // These attribute checks are clues only; scripts can attach handlers in other ways.
    const mouse = (e) =>
        [
            "onclick",
            "ondblclick",
            "onmousedown",
            "onmouseup",
            "onpointerdown",
            "onpointerup",
        ].some((a) => e.hasAttribute(a)),
        keys = (e) => ["onkeydown", "onkeyup", "onkeypress"].some((a) => e.hasAttribute(a));
    // Build one snapshot of the selected scope: inventories, review signals, and effort estimates.
    function scan(root = scanRoot) {
        // Separate built-in controls from custom ARIA and inline-handler patterns.
        const native = scoped(
            'button,a[href],input:not([type="hidden"]),select,textarea,summary',
            root
        ),
            forms = scoped('input:not([type="hidden"]),select,textarea', root),
            buttons = scoped(
                "button,input[type=button],input[type=submit],input[type=reset],[role=button]",
                root
            ),
            links = scoped("a[href],[role=link]", root),
            headings = scoped("h1,h2,h3,h4,h5,h6", root),
            images = scoped("img,svg[role=img],canvas", root),
            landmarks = scoped(
                "header,nav,main,aside,footer,form,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo]",
                root
            ),
            frames = scoped("iframe", root),
            media = scoped("audio,video", root);
        const cb = scoped("[role=button]:not(button)", root),
            cl = scoped("[role=link]:not(a[href])", root),
            cc = scoped("[role=checkbox]:not(input[type=checkbox])", root),
            cr = scoped("[role=radio]:not(input[type=radio])", root),
            cs = scoped("[role=switch]", root),
            ct = scoped("[role=tab]", root),
            cco = scoped("[role=combobox]:not(select)", root),
            csl = scoped("[role=slider]:not(input[type=range])", root),
            cand = scoped("div,span,li,p,section,article,td,th", root),
            inline = cand.filter(
                (e) =>
                    (mouse(e) || keys(e)) &&
                    !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(e.tagName)
            ),
            focusable = cand.filter(
                (e) =>
                    !e.hasAttribute("role") &&
                    e.hasAttribute("tabindex") &&
                    +e.getAttribute("tabindex") >= 0
            ),
            custom = uniq([
                ...cb,
                ...cl,
                ...cc,
                ...cr,
                ...cs,
                ...ct,
                ...cco,
                ...csl,
                ...inline,
                ...focusable,
            ]),
            all = uniq([...native, ...custom]);
        // Widget lists support both the effort model and targeted "Inspect" actions.
        const widgets = {
            comboboxes: uniq([...scoped("[role=combobox]", root), ...scoped("select", root)]),
            dialogs: scoped("dialog,[role=dialog],[role=alertdialog]", root),
            grids: scoped("[role=grid],[role=treegrid]", root),
            listboxes: scoped("[role=listbox]", root),
            tablists: scoped("[role=tablist]", root),
            trees: scoped("[role=tree],[role=treegrid]", root),
            menus: scoped("[role=menu],[role=menubar]", root),
            sliders: uniq([...scoped("[role=slider]", root), ...scoped("input[type=range]", root)]),
            tables: uniq(scoped("table,[role=table],[role=grid],[role=treegrid]", root)),
        };
        // Store only non-empty findings; each finding carries its elements and denominator.
        const findings = [];
        function add(label, elements, weight, category, opportunities) {
            elements = uniq(elements);
            if (elements.length)
                findings.push({
                    label,
                    elements,
                    count: elements.length,
                    weight,
                    category,
                    opportunities: Math.max(opportunities || 1, 1),
                });
        }
        const broken = (a) =>
            scoped(`[${a}]`, root).filter((e) => {
                const v = e.getAttribute(a);
                // ID lookups use the document, so references inside shadow roots are not resolved.
                return !v || v.split(/\s+/).some((id) => !document.getElementById(id));
            });
        add(
            "Form controls without an apparent accessible name",
            forms.filter((e) => !accName(e)),
            5,
            "Control quality",
            forms.length
        );
        add(
            "Button controls without an apparent accessible name",
            buttons.filter((e) => !accName(e)),
            5,
            "Control quality",
            buttons.length
        );
        add(
            "Link controls without an apparent accessible name",
            links.filter((e) => !accName(e)),
            5,
            "Control quality",
            links.length
        );
        [
            ["aria-labelledby", 5],
            ["aria-describedby", 3],
            ["aria-controls", 3],
        ].forEach(([a, w]) =>
            add(
                `Broken ${a} references`,
                broken(a),
                w,
                "ARIA integrity",
                scoped(`[${a}]`, root).length
            )
        );
        // Findings are normalized against relevant opportunities and combined as a weighted signal.
        add(
            "Elements using a positive tabindex",
            scoped("[tabindex]", root).filter((e) => +e.getAttribute("tabindex") > 0),
            3,
            "Keyboard review",
            all.length
        );
        add(
            "Possible mouse-only non-native controls",
            inline.filter(
                (e) =>
                    mouse(e) && !keys(e) && !e.hasAttribute("role") && !e.hasAttribute("tabindex")
            ),
            5,
            "Keyboard review",
            all.length
        );
        let weighted = 0,
            totalWeight = 0;
        findings.forEach((f) => {
            weighted += (clamp((f.count / f.opportunities) * 100) / 100) * f.weight;
            totalWeight += f.weight;
        });
        // Scope load reflects inventory size; interaction load weights complex widgets more heavily.
        const issue = totalWeight ? weighted / totalWeight : 0,
            reviewLoad = Math.round(issue * 100),
            scopeUnits =
                all.length +
                headings.length * 0.25 +
                images.length * 0.25 +
                landmarks.length * 0.5 +
                widgets.tables.length * 2 +
                frames.length * 3 +
                media.length * 3,
            scopeLoad = Math.round(clamp((100 * Math.log1p(scopeUnits)) / Math.log1p(300)));
        const defs = [
            ["Custom buttons", cb, 0.5],
            ["Custom links", cl, 0.5],
            ["Custom checkboxes", cc, 1],
            ["Custom radio buttons", cr, 1],
            ["Custom switches", cs, 1.5],
            ["Custom tabs", ct, 1.5],
            ["Custom comboboxes", cco, 3],
            ["Custom sliders", csl, 3],
            ["Inline non-native interactions", inline, 1.5],
            ["Focusable non-native elements", focusable, 1.5],
            ["Dialogs", widgets.dialogs, 4],
            ["Grids and treegrids", widgets.grids, 7],
            ["Listboxes", widgets.listboxes, 3],
            ["Tablists", widgets.tablists, 3],
            ["Trees", widgets.trees, 7],
            ["Menus", widgets.menus, 3],
        ],
            // Keep only present drivers, ranked by their contribution to interaction units.
            drivers = defs
                .map(([label, elements, weight]) => ({
                    label,
                    elements,
                    count: elements.length,
                    weight,
                    contribution: elements.length * weight,
                }))
                .filter((x) => x.count)
                .sort((a, b) => b.contribution - a.contribution),
            units = drivers.reduce((a, x) => a + x.contribution, 0),
            interactionLoad = Math.round(clamp((100 * Math.log1p(units)) / Math.log1p(80))),
            effortIndex = Math.round(
                clamp(
                    scopeLoad * 0.4 +
                    interactionLoad * 0.3 +
                    reviewLoad * 0.2 +
                    assessment.difficulty * 0.1
                )
            );
        // Recommend manual test focus based on the patterns found in this scope.
        const focus = [];
        if (custom.length)
            focus.push(
                "Validate names, roles, states, focusability, and keyboard operation for custom controls."
            );
        if (widgets.dialogs.length || widgets.menus.length)
            focus.push(
                "Verify dismissal, focus movement, and focus return for overlays and menus."
            );
        if (widgets.grids.length || widgets.trees.length || widgets.tablists.length)
            focus.push("Verify composite-widget keyboard navigation and state communication.");
        if (!focus.length)
            focus.push(
                "Complete standard keyboard, focus, visual, and assistive technology checks."
            );
        return {
            time: new Date(),
            scopeUnits,
            scopeLoad,
            scope:
                scopeUnits >= 150
                    ? "VERY LARGE"
                    : scopeUnits >= 75
                        ? "LARGE"
                        : scopeUnits >= 30
                            ? "MEDIUM"
                            : "SMALL",
            units,
            interactionLoad,
            complexity:
                units >= 35
                    ? "VERY ADVANCED"
                    : units >= 15
                        ? "ADVANCED"
                        : units >= 5
                            ? "MODERATE"
                            : "BASIC",
            effortIndex,
            effort:
                effortIndex >= 80
                    ? "EXTENSIVE"
                    : effortIndex >= 60
                        ? "HIGH"
                        : effortIndex >= 40
                            ? "MODERATE"
                            : effortIndex >= 20
                                ? "TYPICAL"
                                : "LIGHT",
            reviewLoad,
            native,
            custom,
            all,
            forms,
            headings,
            images,
            landmarks,
            frames,
            media,
            widgets,
            findings,
            drivers,
            focus,
        };
    }

    // Phase 4: translate results and support scope selection
    // These helpers provide report labels, element inspection, and picker behavior.
    // Map estimates to short labels for the report summary.
    const priority = (r) =>
        r.effort === "EXTENSIVE" || r.findings.length >= 7
            ? "HIGH"
            : r.effort === "HIGH" || r.findings.length >= 4
                ? "MEDIUM"
                : "LOW";
    const reviewer = (r) =>
        r.complexity === "VERY ADVANCED"
            ? "Senior reviewer with specialist support"
            : r.complexity === "ADVANCED"
                ? "Accessibility Reviewer"
                : r.complexity === "MODERATE"
                    ? "Reviewer familiar with accessibility"
                    : "General reviewer";
    // Compare detail levels by rank so report sections can be progressively revealed.
    const atLeast = (l) =>
        ({ basic: 0, standard: 1, detailed: 2, diagnostic: 3 })[detail] >=
        { basic: 0, standard: 1, detailed: 2, diagnostic: 3 }[l];
    function clearMarks() {
        if (clearMarksTimer !== null) {
            clearTimeout(clearMarksTimer);
            clearMarksTimer = null;
        }
        marked.forEach((e) => e?.classList.remove(HL, PICK));
        marked = [];
    }
    // Build a compact, readable description for picker instructions and console output.
    function describe(e) {
        return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""}${accName(e) ? ` "${accName(e).slice(0, 45)}"` : ""}`;
    }

    // Temporarily highlight matching elements on the page and log them for inspection.
    // The timeout removes the visual marks without changing the current scope.
    function inspect(label, elements) {
        clearMarks();
        elements = uniq(elements).filter(
            (e) => e instanceof Element && document.documentElement.contains(e)
        );
        console.group(`Level Estimator: ${label}`);
        elements.forEach((e, i) => {
            console.log(`${i + 1}. ${describe(e)}`, e);
            e.classList.add(HL);
        });
        console.groupEnd();
        marked = elements;
        elements[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
        clearMarksTimer = setTimeout(clearMarks, 8000);
    }
    // Small constructors keep report markup consistent and avoid inserting page text as HTML.
    function button(text, cls = "") {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `ll-btn ${cls}`;
        b.textContent = text;
        return b;
    }
    function heading(text, n = 3) {
        const h = document.createElement(`h${n}`);
        h.textContent = text;
        return h;
    }
    function card(label, value, tone = "neutral", small = "") {
        const d = document.createElement("div");
        d.className = `ll-card ll-${tone}`;
        const l = document.createElement("span");
        l.textContent = label;
        const s = document.createElement("strong");
        s.textContent = value;
        d.append(l, s);
        if (small) {
            const x = document.createElement("small");
            x.textContent = small;
            d.append(x);
        }
        return d;
    }
    // Return the active region, falling back to the whole-page region.
    const current = () => regions.find((r) => r.id === active) || regions[0];
    // Rebuild the scope dropdown so it reflects current regions and nesting.
    function fill(root) {
        const s = root.querySelector("#ll-region");
        if (!s) return;
        s.replaceChildren();
        regions.forEach((r) => {
            const o = document.createElement("option");
            o.value = r.id;
            o.textContent = `${r.nested ? "↳ " : ""}${r.label}${r.confidence === "low" ? " — inferred" : ""}`;
            o.selected = r.id === active;
            s.append(o);
        });
    }

    // Switching scope always rescans it and refreshes the visible report.
    function apply(id, root) {
        const r = regions.find((x) => x.id === id) || regions[0];
        active = r.id;
        scanRoot = r.element instanceof Element ? r.element : document;
        render(root, scan(scanRoot));
        requestAnimationFrame(() => root.querySelector("#ll-region")?.focus());
    }
    // Add the evaluator's chosen element as the single manual region for this session.
    function addManual(e) {
        const r = {
            id: `manual-${Date.now()}`,
            element: e,
            type: "manual",
            label: `Manual selection: ${label(e, "manual")}`,
            source: "evaluator selection",
            confidence: "high",
            items: content(e),
        };
        regions = regions.filter((x) => x.type !== "manual");
        regions.push(r);
        return r;
    }

    // The picker temporarily captures page pointer/keyboard events. stopPicker removes
    // those listeners so normal page interaction resumes after selection or cancel.
    // It also removes the dialog and returns focus to the initiating button when requested.
    function stopPicker(root, focus = true) {
        if (!picker) return;
        document.removeEventListener("mouseover", picker.over, true);
        document.removeEventListener("click", picker.click, true);
        document.removeEventListener("keydown", picker.key, true);
        picker.nav.remove();
        clearMarks();
        const init = picker.init;
        picker = null;
        root.querySelector("#ll-widget").hidden = false;
        if (focus) init.focus();
    }
    // The nested helpers update the highlighted candidate, accept it, and redraw the picker controls.
    function startPicker(root, init) {
        stopPicker(root, false);
        root.querySelector("#ll-widget").hidden = true;
        let c = document.body;
        const nav = document.createElement("div");
        nav.id = "ll-picker";
        nav.setAttribute("role", "dialog");
        nav.setAttribute("aria-label", "Manual scope selection");
        nav.tabIndex = -1;
        root.append(nav);
        function set(e) {
            if (!(e instanceof Element) || e.closest(`#${ID}`)) return;
            c?.classList.remove(PICK);
            c = e;
            c.classList.add(PICK);
            marked = [c];
            draw();
        }
        // Save the current element as the manual scope and immediately scan it.
        function use() {
            const e = c;
            stopPicker(root, false);
            const r = addManual(e);
            apply(r.id, root);
        }
        function draw() {
            nav.replaceChildren();
            nav.append(
                heading("Manual scope selection"),
                Object.assign(document.createElement("p"), {
                    textContent: "Point to an element or use the controls. Press Escape to cancel.",
                }),
                Object.assign(document.createElement("p"), {
                    className: "ll-current",
                    textContent: describe(c),
                })
            );
            const a = document.createElement("div");
            a.className = "ll-actions";
            [
                ["Parent", () => set(c.parentElement), !c.parentElement],
                [
                    "Previous sibling",
                    () => set(c.previousElementSibling),
                    !c.previousElementSibling,
                ],
                ["Next sibling", () => set(c.nextElementSibling), !c.nextElementSibling],
                ["First child", () => set(c.firstElementChild), !c.firstElementChild],
                ["Use this element", use, false],
                ["Cancel", () => stopPicker(root), false],
            ].forEach(([t, f, d]) => {
                const b = button(t, t.startsWith("Use") ? "primary" : "");
                b.disabled = d;
                b.onclick = f;
                a.append(b);
            });
            nav.append(a);
        }
        // Capture page events while picking; Escape cancels and a page click accepts.
        const over = (e) => {
            if (e.target instanceof Element && !e.target.closest(`#${ID}`)) set(e.target);
        },
            click = (e) => {
                if (e.target instanceof Element && !e.target.closest(`#${ID}`)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    set(e.target);
                    use();
                }
            },
            key = (e) => {
                if (e.key === "Escape") stopPicker(root);
            };
        picker = { over, click, key, init, nav };
        document.addEventListener("mouseover", over, true);
        document.addEventListener("click", click, true);
        document.addEventListener("keydown", key, true);
        set(document.body);
        nav.focus();
    }
    // Phase 5: build the report inside the widget's Shadow DOM
    // Keep page discovery and scoring out of this function; it only presents results.
    function render(root, r) {
        root.querySelector("#ll-report")?.remove();
        const report = document.createElement("div");
        report.id = "ll-report";
        const cur = current(),
            pri = priority(r),
            count = regions.length - 1;
        const controls = document.createElement("section");

        // Card 1: tool title and subtitle.
        controls.className = "ll-brand";
        controls.append(
            heading("Level Estimator", 2),
            Object.assign(document.createElement("p"), {
                textContent: "Page Complexity Review & Planning",
            })
        );

        // Build the Estimate Detail controls.
        // These are added to their own card after the scope card is created.
        const dl = document.createElement("label");
        dl.htmlFor = "ll-detail";
        dl.textContent = "Estimate detail";

        const ds = document.createElement("select");
        ds.id = "ll-detail";
        ds.className = "ll-select";

        [
            ["basic", "Basic"],
            ["standard", "Standard"],
            ["detailed", "Detailed"],
            ["diagnostic", "Diagnostic"],
        ].forEach(([v, t]) => {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = t;
            o.selected = v === detail;
            ds.append(o);
        });

        ds.onchange = () => {
            const old = detail;
            const order = {
                basic: 0,
                standard: 1,
                detailed: 2,
                diagnostic: 3,
            };

            detail = ds.value;

            notice =
                order[detail] > order[old]
                    ? `Estimate detail changed to ${ds.options[ds.selectedIndex].text}. Additional information is now available below.`
                    : order[detail] < order[old]
                        ? `Estimate detail changed to ${ds.options[ds.selectedIndex].text}. The report was simplified.`
                        : "";

            render(root, r);

            requestAnimationFrame(() => {
                root.querySelector("#ll-detail")?.focus();
            });
        };

        const status = document.createElement("div");
        status.className = "ll-notice";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.setAttribute("aria-atomic", "true");
        status.textContent = notice;
        status.hidden = !notice;

        // Card 3: current scope and scope-selection controls.
        const scope = document.createElement("section");
        scope.className = "ll-panel";

        scope.append(
            heading("Current scope"),
            Object.assign(document.createElement("p"), {
                className: "ll-scope",
                textContent: cur.label,
            })
        );

        const sl = document.createElement("label");
        sl.htmlFor = "ll-region";
        sl.textContent = "Select a discovered section";

        const ss = document.createElement("select");
        ss.id = "ll-region";
        ss.className = "ll-select";
        ss.onchange = () => apply(ss.value, root);

        const meta = Object.assign(document.createElement("p"), {
            className: "ll-note",
            textContent:
                cur.type === "page"
                    ? "Entire page is selected by default."
                    : `Identified from ${cur.source}; ${cur.confidence} boundary confidence.`,
        });

        const acts = document.createElement("div");
        acts.className = "ll-actions";

        const manual = button("Select manually", "primary");
        const ins = button("Inspect current scope");
        const reset = button("Reset to entire page");

        reset.hidden = cur.type === "page";

        manual.onclick = () => startPicker(root, manual);

        ins.onclick = () =>
            inspect(cur.label, [
                scanRoot instanceof Element ? scanRoot : document.body,
            ]);

        reset.onclick = () => apply("page", root);

        acts.append(manual, ins, reset);
        scope.append(sl, ss, meta, acts);

        // Card 4: Estimate Detail.
        const detailCard = document.createElement("section");
        detailCard.className = "ll-panel ll-detail-panel";

        detailCard.append(
            heading("Estimate detail"),
            dl,
            ds,
            status
        );

        // Card 2: page complexity summary.
        const assess = document.createElement("section");
        assess.className = "ll-panel";

        assess.append(heading("Page complexity summary"));

        const grid = document.createElement("div");
        grid.className = "ll-grid";

        grid.append(
            card(
                "Complexity",
                pri,
                pri === "LOW"
                    ? "good"
                    : pri === "MEDIUM"
                        ? "caution"
                        : "attention"
            ),
            card(
                "Evaluation effort",
                r.effort,
                ["LIGHT", "TYPICAL"].includes(r.effort)
                    ? "good"
                    : r.effort === "MODERATE"
                        ? "caution"
                        : "attention"
            ),
            card(
                "Suggested review experience",
                reviewer(r),
                "purple"
            ),
            card(
                "Scope boundary quality",
                assessment.rating,
                assessment.rating === "CLEAR"
                    ? "good"
                    : assessment.rating === "MIXED"
                        ? "caution"
                        : "attention"
            ),
            card(
                "Sections available",
                String(count),
                "navy"
            )
        );

        assess.append(grid);

        // Required reading and visual order:
        // 1. Title and subtitle
        // 2. Page complexity summary
        // 3. Current scope
        // 4. Estimate detail
        report.append(
            controls,
            assess,
            scope,
            detailCard
        );
        if (atLeast("standard")) {
            // Standard adds strategy, discovery confidence, and advanced-widget inventory.
            const strategy = document.createElement("section");
            strategy.append(heading("Review planning"));
            const ul = document.createElement("ul");
            ul.className = "ll-strategy";
            const points = [];
            if (assessment.rating !== "DIFFICULT" && count >= 3)
                points.push(
                    ["positive", "Divide the evaluation by discovered section."],
                    ["positive", "Independent sections may support parallel testing."]
                );
            else
                points.push([
                    "attention",
                    "Confirm evaluation boundaries manually before assigning sections.",
                ]);
            if (/ADVANCED/.test(r.complexity))
                points.push([
                    "attention",
                    "Assign advanced interaction patterns to an experienced tester.",
                ]);
            if (r.findings.length)
                points.push([
                    "attention",
                    `Review ${r.findings.length} automatically detected review area${r.findings.length === 1 ? "" : "s"}.`,
                ]);
            points.forEach(([tone, text]) => {
                const li = document.createElement("li");
                li.className = tone;
                li.textContent = `${tone === "positive" ? "✓" : "•"} ${text}`;
                ul.append(li);
            });
            strategy.append(ul);
            report.append(strategy);
            const discovery = document.createElement("section");
            discovery.append(heading("Section discovery"));
            const dg = document.createElement("div");
            dg.className = "ll-grid";
            dg.append(
                card(
                    "Scope boundary quality",
                    assessment.rating,
                    assessment.rating === "CLEAR"
                        ? "good"
                        : assessment.rating === "MIXED"
                            ? "caution"
                            : "attention"
                ),
                card("Identified sections", String(count), "navy"),
                card(
                    "Major headings mapped",
                    `${assessment.mapped} of ${assessment.total}`,
                    "purple"
                ),
                card(
                    "Low-confidence regions",
                    String(assessment.low),
                    assessment.low ? "caution" : "good"
                )
            );
            discovery.append(
                dg,
                Object.assign(document.createElement("p"), {
                    className: "ll-explain",
                    textContent: assessment.description,
                })
            );
            report.append(discovery);
            const components = document.createElement("section");
            components.append(heading("Advanced components"));
            const cg = document.createElement("div");
            cg.className = "ll-grid";
            [
                ["Comboboxes", r.widgets.comboboxes],
                ["Dialogs", r.widgets.dialogs],
                ["Grids", r.widgets.grids],
                ["Listboxes", r.widgets.listboxes],
                ["Tablists", r.widgets.tablists],
                ["Trees", r.widgets.trees],
                ["Menus", r.widgets.menus],
                ["Sliders", r.widgets.sliders],
            ].forEach(([l, e]) => {
                if (!e.length && detail !== "diagnostic") return;
                const c = card(l, String(e.length), e.length ? "purple" : "neutral");
                if (e.length) {
                    const b = button("Inspect");
                    b.onclick = () => inspect(l, e);
                    c.append(b);
                }
                cg.append(c);
            });
            components.append(
                cg.children.length
                    ? cg
                    : Object.assign(document.createElement("p"), {
                        textContent:
                            "No advanced composite widgets were detected in the current scope.",
                    })
            );
            report.append(components);
        }
        if (atLeast("detailed")) {
            // Detailed adds the full inventory, effort drivers, and review findings.
            const inv = document.createElement("section");
            inv.append(heading("Scope and control inventory"));
            const ig = document.createElement("div");
            ig.className = "ll-grid";
            [
                ["Native controls", r.native.length],
                ["Custom controls", r.custom.length],
                ["All controls", r.all.length],
                ["Form controls", r.forms.length],
                ["Headings", r.headings.length],
                ["Images and canvases", r.images.length],
                ["Landmarks", r.landmarks.length],
                ["Tables and grids", r.widgets.tables.length],
            ].forEach(([l, v]) => ig.append(card(l, String(v))));
            inv.append(ig);
            report.append(inv);
            const cx = document.createElement("section");
            cx.append(heading("Complexity drivers"));
            const ol = document.createElement("ol");
            ol.className = "ll-cards";
            r.drivers.forEach((d) => {
                const li = document.createElement("li");
                li.append(
                    Object.assign(document.createElement("strong"), {
                        textContent: `${d.label}: ${d.count}`,
                    }),
                    Object.assign(document.createElement("p"), {
                        className: "ll-note",
                        textContent:
                            detail === "diagnostic"
                                ? `${d.count} × ${d.weight.toFixed(1)} = ${d.contribution.toFixed(1)} interaction units.`
                                : "This pattern contributes to evaluation effort and reviewer planning.",
                    })
                );
                const b = button("Inspect");
                b.onclick = () => inspect(d.label, d.elements);
                li.append(b);
                ol.append(li);
            });
            cx.append(ol, heading("Suggested review focus", 4));
            const fu = document.createElement("ul");
            r.focus.forEach((x) =>
                fu.append(Object.assign(document.createElement("li"), { textContent: x }))
            );
            cx.append(fu);
            report.append(cx);
            const areas = document.createElement("section");
            areas.append(heading(`Review signals to investigate (${r.findings.length})`));
            const fa = document.createElement("ol");
            fa.className = "ll-cards";
            r.findings.forEach((f) => {
                const li = document.createElement("li");
                li.append(
                    Object.assign(document.createElement("strong"), {
                        textContent: `${f.label}: ${f.count}`,
                    }),
                    Object.assign(document.createElement("p"), {
                        className: "ll-note",
                        textContent: `${f.category}. ${f.count} of ${f.opportunities} relevant opportunities.`,
                    })
                );
                const b = button("Inspect");
                b.onclick = () => inspect(f.label, f.elements);
                li.append(b);
                fa.append(li);
            });
            areas.append(
                r.findings.length
                    ? fa
                    : Object.assign(document.createElement("p"), {
                        textContent:
                            "No review signals were detected in this scope. This does not rule out the need for manual review.",
                    })
            );
            report.append(areas);
        }
        if (atLeast("diagnostic")) {
            // Diagnostic exposes the component loads behind the effort index.
            const d = document.createElement("section");
            d.className = "ll-diagnostic";
            d.append(heading("Diagnostic calculations"));
            const g = document.createElement("div");
            g.className = "ll-grid";
            [
                ["Scope units", Math.round(r.scopeUnits)],
                ["Scope load", `${r.scopeLoad}/100`],
                ["Interaction units", r.units.toFixed(1)],
                ["Interaction load", `${r.interactionLoad}/100`],
                ["Review signal load", `${r.reviewLoad}/100`],
                ["Scoping difficulty", `${assessment.difficulty}/100`],
                ["Effort index", `${r.effortIndex}/100`],
                ["Boundary confidence", `${assessment.score}/100`],
            ].forEach(([l, v]) => g.append(card(l, String(v), "diagnostic")));
            d.append(
                g,
                Object.assign(document.createElement("p"), {
                    className: "ll-explain",
                    textContent:
                        "Effort index = 40% scope load + 30% interaction load + 20% review-signal load + 10% scoping difficulty.",
                })
            );
            report.append(d);
        }
        root.querySelector("#ll-report-region").append(report);
        fill(root);
        root.querySelector("#ll-label").textContent = `Level Estimator: ${cur.label}`;
        root.querySelector("#ll-summary").textContent =
            `${pri} review priority; ${r.effort.toLowerCase()} effort`;
        root.querySelector("#ll-time").textContent = `Updated ${r.time.toLocaleTimeString()}`;
    }

    // Phase 6: refresh, style, and create the widget
    // Rediscover sections after a refresh while keeping the current scope when possible.
    function refresh(root, preserve = true) {
        // Only discovered regions are recreated here; manual regions fall back to page scope.
        const old = preserve && scanRoot instanceof Element ? scanRoot : null;
        discover();
        if (old && document.documentElement.contains(old)) {
            const match = regions.find((r) => r.element === old);
            if (match) {
                active = match.id;
                scanRoot = match.element;
            } else {
                active = "page";
                scanRoot = document;
            }
        } else {
            active = "page";
            scanRoot = document;
        }
        render(root, scan(scanRoot));
    }
    // Highlight classes must be styled in the page document; widget styles live in Shadow DOM.
    function installStyle() {
        document.getElementById(STYLE)?.remove();
        const s = document.createElement("style");
        s.id = STYLE;
        s.textContent = `
.${HL} {
    outline: 4px solid #b400ff !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 7px rgba(255, 223, 0, 0.85) !important;
}
.${PICK} {
    outline: 4px solid #6e37b3 !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 7px rgba(255, 223, 0, 0.85) !important;
}
`;
        document.head.append(s);
    }
    // Create the isolated UI, wire its controls, then perform the initial discovery and scan.
    function create(force = false) {
        const old = document.getElementById(ID);
        if (old && !force) {
            old.shadowRoot.querySelector("#ll-widget").hidden = false;
            old.shadowRoot.querySelector("#ll-launcher").hidden = true;
            return;
        }
        // Forced recreation must detach document-level picker listeners before removing its UI.
        if (old && picker) stopPicker(old.shadowRoot, false);
        old?.remove();
        installStyle();
        const host = document.createElement("div");
        host.id = ID;
        const root = host.attachShadow({ mode: "open" }),
            style = document.createElement("style");
        // Keep widget layout and colors independent from the host page's styles.
        style.textContent = `
:host {
    all: initial;
    --purple: #6e37b3;
    --navy: #0b1b3d;
    --navy2: #122448;
    --bg: #f5f3f9;
    --border: #d9d3e2;
    --text: #0b1b3d;
    --muted: #536078;
    --green: #137333;
    --greenBg: #e8f7ef;
    --amber: #8a4b00;
    --amberBg: #fff7e0;
    --red: #8e0016;
    --redBg: #fdeded;
}
* {
    box-sizing: border-box;
}
.ll-widget,
.ll-launcher,
#ll-picker {
    position: fixed;
    top: 10px;
    left: 10px;
    z-index: 2147483647;
    font:
        14px/1.45 Arial,
        sans-serif;
}
.ll-widget {
    width: min(500px, calc(100vw - 20px));
    color: var(--text);
}
.ll-widget[hidden],
.ll-launcher[hidden],
.ll-panel-wrap[hidden],
.ll-btn[hidden],
.ll-notice[hidden] {
    display: none !important;
}
.ll-launcher,
.ll-disclosure,
.ll-btn {
    min-height: 38px;
    border: 1px solid #8fa0bd;
    border-radius: 6px;
    color: #fff;
    background: var(--navy2);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
}
.ll-launcher {
    padding: 8px 14px;
    background: var(--purple);
    border: 2px solid #fff;
}
.ll-disclosure {
    width: 100%;
    min-height: 50px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    text-align: left;
    background: linear-gradient(90deg, var(--navy), var(--purple));
    border: 2px solid #fff;
}
.ll-btn {
    padding: 7px 10px;
}
.ll-btn.primary {
    background: var(--purple);
}
.ll-btn.danger {
    background: var(--red);
}
.ll-btn:focus-visible,
.ll-disclosure:focus-visible,
.ll-select:focus-visible {
    outline: 3px solid #c9a7f2;
    outline-offset: 3px;
}
.ll-panel-wrap {
    margin-top: 6px;
    max-height: calc(100vh - 75px);
    overflow: auto;
    border: 2px solid var(--navy);
    border-radius: 10px;
    background: var(--bg);
    box-shadow: 0 7px 24px rgba(11, 27, 61, 0.4);
}
.ll-toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    padding: 10px;
    background: var(--navy);
}
#ll-report {
    padding: 12px;
    color: var(--text);
}
#ll-report section + section {
    margin-top: 16px;
    padding-top: 15px;
    border-top: 1px solid var(--border);
}
h2,
h3,
h4 {
    margin: 0 0 10px;
    color: var(--navy);
}
.ll-brand {
    padding: 16px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--navy), var(--purple));
    color: #fff;
}
.ll-brand h2 {
    color: #fff;
    font-size: 27px;
}
.ll-brand p {
    margin: 2px 0 14px;
}
.ll-brand label,
.ll-panel label {
    display: block;
    font-weight: 700;
}
.ll-select {
    display: block;
    width: 100%;
    min-height: 42px;
    margin-top: 5px;
    padding: 7px;
    border: 2px solid var(--purple);
    border-radius: 6px;
    background: #fff;
    font: inherit;
}
.ll-brand .ll-select {
    max-width: 220px;
    border-color: #fff;
}
.ll-notice {
    margin-top: 12px;
    padding: 9px 10px;
    border-left: 5px solid var(--purple);
    border-radius: 6px;
    color: var(--navy);
    background: #f7f1fc;
    font-weight: 700;
}
.ll-panel {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 3px 12px rgba(11, 27, 61, 0.08);
}
.ll-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
}
.ll-card {
    padding: 10px;
    border-left: 5px solid var(--border);
    border-radius: 7px;
    background: #fff;
    box-shadow: 0 1px 5px rgba(11, 27, 61, 0.1);
}
.ll-card span,
.ll-card small,
.ll-note{
    display: block;
    color: var(--muted);
    font-size: 12px;
}
#ll-time {
display: block;
color: #ffffff;
font-size: 12px;
}
.ll-card strong {
    display: block;
    margin: 3px 0;
    color: var(--navy);
    font-size: 17px;
    overflow-wrap: anywhere;
}
.ll-good {
    border-color: var(--green);
    background: var(--greenBg);
}
.ll-caution {
    border-color: var(--amber);
    background: var(--amberBg);
}
.ll-attention {
    border-color: var(--red);
    background: var(--redBg);
}
.ll-purple {
    border-color: var(--purple);
}
.ll-navy {
    border-color: var(--navy);
}
.ll-strategy {
    list-style: none;
    padding: 0;
}
.ll-strategy li {
    margin: 7px 0;
    padding: 9px;
    background: #fff;
}
.ll-strategy .positive {
    border-left: 4px solid var(--green);
}
.ll-strategy .attention {
    border-left: 4px solid var(--amber);
}
.ll-scope {
    color: var(--purple);
    font-size: 19px;
    font-weight: 700;
}
.ll-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}
.ll-cards li {
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #fff;
}
.ll-explain {
    padding: 10px;
    border-left: 4px solid var(--purple);
    background: #fff;
}
.ll-diagnostic {
    padding: 12px;
    border: 2px dashed var(--purple);
    border-radius: 9px;
    background: #f2eafb;
}
#ll-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#ll-summary {
    font-size: 12px;
}
#ll-picker {
    width: min(520px, calc(100vw - 20px));
    padding: 14px;
    border: 3px solid var(--purple);
    border-radius: 10px;
    color: #fff;
    background: var(--navy);
}
#ll-picker h3 {
    color: #fff;
}
.ll-current {
    padding: 8px;
    background: var(--navy2);
}
@media (max-width: 500px) {
    .ll-grid {
        grid-template-columns: 1fr;
    }
    #ll-summary {
        display: none;
    }
}
`;
        const launcher = button("Level Estimator");
        launcher.id = "ll-launcher";
        launcher.className = "ll-launcher";
        launcher.hidden = true;
        const widget = document.createElement("div");
        widget.id = "ll-widget";
        widget.className = "ll-widget";
        const disclosure = button("");
        disclosure.id = "ll-disclosure";
        disclosure.className = "ll-disclosure";
        disclosure.setAttribute("aria-expanded", "false");
        disclosure.setAttribute("aria-controls", "ll-panel");
        const l = document.createElement("span");
        l.id = "ll-label";
        l.textContent = "Level Estimator";
        const sum = document.createElement("span");
        sum.id = "ll-summary";
        sum.setAttribute("aria-hidden", "true");
        disclosure.append(l, sum);
        const panel = document.createElement("div");
        panel.id = "ll-panel";
        panel.className = "ll-panel-wrap";
        panel.hidden = true;
        const toolbar = document.createElement("div");
        toolbar.className = "ll-toolbar";
        const rescan = button("Rediscover and rescan", "primary"),
            clear = button("Clear highlights"),
            hide = button("Hide"),
            remove = button("Remove", "danger"),
            time = document.createElement("p");
        time.id = "ll-time";
        toolbar.append(rescan, clear, hide, remove, time);
        const area = document.createElement("div");
        area.id = "ll-report-region";
        area.setAttribute("aria-live", "polite");
        panel.append(toolbar, area);
        widget.append(disclosure, panel);
        root.append(style, launcher, widget);
        document.documentElement.append(host);
        // Wire the widget's controls after its elements exist in the shadow root.
        disclosure.onclick = () => {
            const open = disclosure.getAttribute("aria-expanded") === "true";
            disclosure.setAttribute("aria-expanded", String(!open));
            panel.hidden = open;
        };
        launcher.onclick = () => {
            launcher.hidden = true;
            widget.hidden = false;
            disclosure.focus();
        };
        hide.onclick = () => {
            widget.hidden = true;
            launcher.hidden = false;
            launcher.focus();
        };
        clear.onclick = clearMarks;
        remove.onclick = () => {
            stopPicker(root, false);
            document.getElementById(STYLE)?.remove();
            host.remove();
        };
        rescan.onclick = () => {
            rescan.disabled = true;
            requestAnimationFrame(() => {
                refresh(root, true);
                rescan.disabled = false;
            });
        };
        refresh(root, false);
    }

    // Phase 7: user entry points and startup
    // Expose one toggle from the page keyboard and userscript menu.
    function toggle() {
        const host = document.getElementById(ID);
        if (!host) return create(true);
        const r = host.shadowRoot,
            w = r.querySelector("#ll-widget"),
            l = r.querySelector("#ll-launcher");
        // The keyboard shortcut alternates between the full widget and its launcher.
        w.hidden = !w.hidden;
        l.hidden = !w.hidden;
        (w.hidden ? l : r.querySelector("#ll-disclosure")).focus();
    }
    document.addEventListener("keydown", (e) => {
        if (e.altKey && e.shiftKey && e.key.toLowerCase() === "a") {
            e.preventDefault();
            toggle();
        }
    });
    if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Open Level Estimator", () => create(true));
        GM_registerMenuCommand("Rediscover and rescan", () => create(true));
    }
    document.readyState === "loading"
        ? document.addEventListener("DOMContentLoaded", () => create(), { once: true })
        : create();
})();
