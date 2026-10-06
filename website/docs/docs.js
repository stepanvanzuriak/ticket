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

  var REPO = "https://github.com/stepanvanzuriak/ticket/blob/main/website/docs/";
  var current = document.body.getAttribute("data-page");
  var flat = [];

  var sidebar = document.getElementById("sidebar");
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

  var index = flat.findIndex(function (p) { return p.slug === current; });
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
    edit.innerHTML = '<a href="' + REPO + current + '.html">Edit this page on GitHub</a>';
  }

  document.querySelectorAll("article h2[id], article h3[id]").forEach(function (h) {
    var a = document.createElement("a");
    a.className = "anchor";
    a.href = "#" + h.id;
    a.setAttribute("aria-label", "Link to this section");
    a.textContent = "#";
    h.appendChild(a);
  });

  var keywords = ["module", "uses", "types", "functions", "effects", "binds", "hosts", "exports", "impls", "traits", "externs", "constants", "routes", "views", "view_component", "resources", "namespace", "root", "only", "except", "member", "collection", "let", "match", "if", "else", "function", "in", "from", "where", "as", "try", "catch", "throw", "true", "false"];
  var pattern = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(&lt;|&gt;|&amp;)|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-z_][A-Za-z0-9_]*)\b/g;
  document.querySelectorAll('pre.code[data-lang="polar"] code').forEach(function (el) {
    el.innerHTML = el.innerHTML.replace(pattern, function (m, cm, st, ent, ty, id) {
      if (cm) return '<span class="cm">' + cm + "</span>";
      if (st) return '<span class="st">' + st + "</span>";
      if (ent) return ent;
      if (ty) return '<span class="ty">' + ty + "</span>";
      if (keywords.indexOf(id) !== -1) return '<span class="kw">' + id + "</span>";
      return m;
    });
  });
})();
