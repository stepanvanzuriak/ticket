(function () {
  var NAV = [
    {
      title: "Start here",
      pages: [
        ["getting-started", "Getting Started"],
        ["first-app", "Your First App"],
      ],
    },
    {
      title: "Guides",
      pages: [
        ["routing", "Routing"],
        ["controllers", "Controllers"],
        ["filters-and-halting", "Filters and Halting"],
        ["views", "Views and Components"],
        ["params", "Conn and Params"],
        ["database", "Database"],
        ["forms-and-sessions", "Forms and Sessions"],
        ["generators", "Generators"],
        ["testing", "Testing and Console"],
      ],
    },
    {
      title: "Reference",
      pages: [
        ["launcher", "Launcher and Tasks"],
        ["modules", "Modules"],
        ["roadmap", "Roadmap"],
      ],
    },
  ];

  var REPO =
    "https://github.com/stepanvanzuriak/ticket/blob/main/website/docs/";
  var current = document.body.getAttribute("data-page");
  var flat = [];

  var sidebar = document.getElementById("sidebar");
  var search = buildSearch();
  sidebar.appendChild(search);
  NAV.forEach(function (group) {
    var heading = document.createElement("h2");
    heading.textContent = group.title;
    sidebar.appendChild(heading);

    var list = document.createElement("ol");
    group.pages.forEach(function (page) {
      flat.push({ slug: page[0], title: page[1] });

      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = page[0] + ".html";
      link.textContent = page[1];
      if (page[0] === current) link.setAttribute("aria-current", "page");
      item.appendChild(link);
      list.appendChild(item);
    });
    sidebar.appendChild(list);
  });

  var menu = document.querySelector(".menu");
  if (menu) {
    menu.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      menu.setAttribute("aria-expanded", open ? "true" : "false");
      menu.textContent = open ? "Close" : "Menu";
    });
  }

  var index = flat.findIndex(function (p) {
    return p.slug === current;
  });
  var pager = document.getElementById("pager");
  if (pager && index !== -1) {
    var add = function (page, dir, cls) {
      var a = document.createElement("a");
      a.href = page.slug + ".html";
      a.className = cls;
      a.innerHTML = '<span class="dir"></span><span class="title"></span>';
      a.querySelector(".dir").textContent = dir;
      a.querySelector(".title").textContent = page.title;
      pager.appendChild(a);
    };
    if (index > 0) add(flat[index - 1], "Previous", "prev");
    if (index < flat.length - 1) add(flat[index + 1], "Next", "next");
  }

  var edit = document.getElementById("edit");
  if (edit && current) {
    edit.innerHTML =
      '<a href="' + REPO + current + '.html">Edit this page on GitHub</a>';
  }

  document
    .querySelectorAll("article h2[id], article h3[id]")
    .forEach(function (h) {
      var a = document.createElement("a");
      a.className = "anchor";
      a.href = "#" + h.id;
      a.setAttribute("aria-label", "Link to this section");
      a.textContent = "#";
      h.appendChild(a);
    });

  // On this page: every h2 in the article, with the one in view marked.
  var headings = [].slice.call(document.querySelectorAll("article h2[id]"));
  var layout = document.querySelector(".layout");
  if (layout && headings.length > 1) {
    var toc = document.createElement("aside");
    toc.className = "toc";
    toc.setAttribute("aria-label", "On this page");
    toc.innerHTML = "<h2>On this page</h2><ol></ol>";
    var links = headings.map(function (h) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.firstChild.textContent.trim();
      li.appendChild(a);
      toc.querySelector("ol").appendChild(li);
      return a;
    });
    layout.appendChild(toc);

    var mark = function () {
      var at = 0;
      headings.forEach(function (h, i) {
        if (h.getBoundingClientRect().top < window.innerHeight * 0.3) at = i;
      });
      links.forEach(function (a, i) {
        a.classList.toggle("active", i === at);
      });
    };
    var queued = false;
    window.addEventListener(
      "scroll",
      function () {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () {
          queued = false;
          mark();
        });
      },
      { passive: true },
    );
    mark();
  }

  // Copy buttons on source blocks; terminal output under them is left alone.
  if (window.Ticket) {
    document
      .querySelectorAll("article pre.code:not(.out)")
      .forEach(function (pre) {
        var wrap = document.createElement("div");
        wrap.className = "codeblock";
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        var code = pre.querySelector("code") || pre;
        var shell = !!pre.querySelector(".pr");
        wrap.appendChild(
          window.Ticket.copyButton(function () {
            return shell ? window.Ticket.commandText(code) : code.textContent;
          }, "Copy code"),
        );
        // keep the source + output pair joined
        var out = wrap.nextElementSibling;
        if (out && out.matches("pre.code.out"))
          wrap.insertBefore(out, pre.nextSibling);
      });
  }

  // Search over every page's title and section headings, fetched on first use.
  function buildSearch() {
    var box = document.createElement("div");
    box.className = "search";
    box.setAttribute("role", "search");
    box.innerHTML =
      '<label class="visually-hidden" for="doc-search">Search the docs</label>' +
      '<input id="doc-search" type="search" placeholder="Search docs" autocomplete="off" ' +
      'aria-controls="doc-search-results" aria-expanded="false" />' +
      '<kbd aria-hidden="true">/</kbd>' +
      '<div class="results" id="doc-search-results" hidden></div>';
    var input = box.querySelector("input");
    var results = box.querySelector(".results");
    var index = null;
    var loading = null;
    var active = 0;

    function load() {
      if (loading) return loading;
      var pages = [];
      NAV.forEach(function (group) {
        group.pages.forEach(function (p) {
          pages.push({ slug: p[0], title: p[1] });
        });
      });
      // Titles alone still work where fetch can't (file://).
      index = pages.map(function (p) {
        return { href: p.slug + ".html", title: p.title, page: p.title };
      });
      loading = Promise.all(
        pages.map(function (p) {
          return fetch(p.slug + ".html")
            .then(function (r) {
              return r.ok ? r.text() : "";
            })
            .then(function (html) {
              var doc = new DOMParser().parseFromString(html, "text/html");
              return [].slice
                .call(doc.querySelectorAll("article h2[id], article h3[id]"))
                .map(function (h) {
                  return {
                    href: p.slug + ".html#" + h.id,
                    title: h.textContent.trim(),
                    page: p.title,
                  };
                });
            })
            .catch(function () {
              return [];
            });
        }),
      ).then(function (lists) {
        lists.forEach(function (list) {
          index = index.concat(list);
        });
        render();
      });
      return loading;
    }

    function matches() {
      var q = input.value.trim().toLowerCase();
      if (!q || !index) return [];
      var words = q.split(/\s+/);
      return index
        .map(function (item) {
          var hay = (item.title + " " + item.page).toLowerCase();
          if (
            !words.every(function (w) {
              return hay.indexOf(w) !== -1;
            })
          )
            return null;
          var score =
            item.title.toLowerCase().indexOf(q) === 0
              ? 0
              : item.title.toLowerCase().indexOf(q) !== -1
                ? 1
                : 2;
          if (item.href.indexOf("#") === -1) score -= 0.5;
          return { item: item, score: score };
        })
        .filter(Boolean)
        .sort(function (a, b) {
          return a.score - b.score;
        })
        .slice(0, 8)
        .map(function (m) {
          return m.item;
        });
    }

    function render() {
      var q = input.value.trim();
      if (!q) {
        results.hidden = true;
        input.setAttribute("aria-expanded", "false");
        return;
      }
      var found = matches();
      active = Math.min(active, Math.max(found.length - 1, 0));
      results.innerHTML = "";
      if (!found.length) {
        var none = document.createElement("p");
        none.textContent = "Nothing matches “" + q + "”";
        results.appendChild(none);
      }
      found.forEach(function (item, i) {
        var a = document.createElement("a");
        a.href = item.href;
        a.textContent = item.title;
        if (item.title !== item.page) {
          var small = document.createElement("small");
          small.textContent = item.page;
          a.appendChild(small);
        }
        if (i === active) a.classList.add("active");
        results.appendChild(a);
      });
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    input.addEventListener("focus", load);
    input.addEventListener("input", function () {
      active = 0;
      load();
      render();
    });
    input.addEventListener("keydown", function (e) {
      var items = results.querySelectorAll("a");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        active =
          (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) %
          items.length;
        render();
      } else if (e.key === "Enter" && items[active]) {
        e.preventDefault();
        location.href = items[active].href;
      } else if (e.key === "Escape") {
        input.value = "";
        render();
        input.blur();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      var tag =
        (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (!sidebar.offsetParent && menu) menu.click();
      input.focus();
    });
    return box;
  }

  var keywords = [
    "module",
    "uses",
    "types",
    "functions",
    "effects",
    "binds",
    "hosts",
    "exports",
    "impls",
    "traits",
    "externs",
    "constants",
    "routes",
    "views",
    "view_component",
    "resources",
    "namespace",
    "root",
    "only",
    "except",
    "member",
    "collection",
    "let",
    "match",
    "if",
    "else",
    "function",
    "in",
    "from",
    "where",
    "as",
    "try",
    "catch",
    "throw",
    "true",
    "false",
  ];
  var pattern =
    /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(&lt;|&gt;|&amp;)|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-z_][A-Za-z0-9_]*)\b/g;
  document
    .querySelectorAll('pre.code[data-lang="polar"] code')
    .forEach(function (el) {
      el.innerHTML = el.innerHTML.replace(
        pattern,
        function (m, cm, st, ent, ty, id) {
          if (cm) return '<span class="cm">' + cm + "</span>";
          if (st) return '<span class="st">' + st + "</span>";
          if (ent) return ent;
          if (ty) return '<span class="ty">' + ty + "</span>";
          if (keywords.indexOf(id) !== -1)
            return '<span class="kw">' + id + "</span>";
          return m;
        },
      );
    });
})();
