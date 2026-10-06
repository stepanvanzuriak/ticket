
use crate::types::singular;
use polar_plugin::{
  Diagnostic, Entry, Expansion, Generated, Module, Source, Span, Token, Zone, ZonePlugin,
};

pub struct Routes;

const VERBS: [&str; 5] = ["get", "post", "put", "patch", "delete"];

const ACTIONS: [&str; 7] = ["index", "new", "create", "show", "edit", "update", "destroy"];

const NEEDS: [&[&str]; 4] =
  [&["Std", "Http"], &["Std", "Option"], &["Std", "Id"], &["Ticket", "Conn"]];

const PATH_HELP: &str = "a path is `/` or segments like `/posts/:id`, with no spaces";

#[derive(Clone, PartialEq, Eq)]
enum Segment {
  Lit(String),
  Param(String),
}

struct Line<'a> {
  tokens: Vec<&'a Token>,
  children: Vec<Line<'a>>,
}

impl Line<'_> {
  fn span(&self) -> Span {
    self.tokens[0].span.join(self.tokens[self.tokens.len() - 1].span)
  }

  fn head(&self) -> &str {
    &self.tokens[0].text
  }
}

#[derive(Clone)]
struct Scope {
  place: Place,
  path: Vec<Segment>,
  names: Vec<String>,
}

#[derive(Clone)]
enum Place {
  Top,
  Namespace,
  Resources(Resource),
  Block { suffix: String },
}

#[derive(Clone)]
struct Resource {
  member_path: Vec<Segment>,
  member_name: String,
  collection_path: Vec<Segment>,
  collection_name: String,
}

struct Route {
  span: Span,
  method: &'static str,
  segments: Vec<Segment>,
  controller: String,
  action: String,
  name: Option<String>,
}

impl Route {
  fn path(&self) -> String {
    if self.segments.is_empty() {
      return "/".to_string();
    }

    self
      .segments
      .iter()
      .map(|s| match s {
        Segment::Lit(text) => format!("/{text}"),
        Segment::Param(name) => format!("/:{name}"),
      })
      .collect()
  }

  fn shape(&self) -> Vec<Option<&str>> {
    self
      .segments
      .iter()
      .map(|s| match s {
        Segment::Lit(text) => Some(text.as_str()),
        Segment::Param(_) => None,
      })
      .collect()
  }

  fn params(&self) -> Vec<&str> {
    self
      .segments
      .iter()
      .filter_map(|s| match s {
        Segment::Param(name) => Some(name.as_str()),
        Segment::Lit(_) => None,
      })
      .collect()
  }
}

type Options<'t> = (Option<&'t Token>, Option<(&'t Token, Vec<&'t Token>)>);

struct Walk<'m> {
  module: &'m Module,
  routes: Vec<Route>,
  out: Expansion,
}

impl ZonePlugin for Routes {
  fn zone(&self) -> Zone {
    Zone {
      keyword: "routes".to_string(),
      after: "types".to_string(),
      blank_between_entries: false,
    }
  }

  fn expand(&self, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
    let mut walk = Walk { module, routes: Vec::new(), out: Expansion::default() };

    for path in NEEDS {
      if module.import(path).is_none() {
        let name = path.join(".");

        walk.out.error(
          Diagnostic::error(format!("the `routes` zone needs `{name}`"), zone)
            .with_help(format!("add `{name}` to the `uses` zone")),
        );
      }
    }

    if walk.out.has_errors() {
      return walk.out;
    }

    let top = Scope { place: Place::Top, path: Vec::new(), names: Vec::new() };

    for entry in entries {
      for line in nest(entry.lines()) {
        walk.line(&line, &top);
      }
    }

    walk.duplicates();
    walk.helpers();

    if walk.out.has_errors() {
      return walk.out;
    }

    let conn = local(module, &["Ticket", "Conn"]);
    let id = local(module, &["Std", "Id"]);
    let routes = walk.routes;
    let mut out = walk.out;
    let mut exports = Source::new();

    out.emit(table(&routes, zone));
    out.emit(router(&routes, &conn, zone));

    for (i, route) in routes.iter().enumerate() {
      out.emit(try_route(i, route, &conn));
    }

    exports.push("route_table\nrouter");

    for route in &routes {
      if let Some(name) = &route.name {
        out.emit(helper(name, route, &conn, &id));
        exports.push(&format!("\n{name}_path"));
      }
    }

    out.emit(exports.finish("exports", zone));

    if let Some(source) = paths(&routes) {
      out.emit_sibling(PATHS, source, zone);
    }

    out
  }

  fn print(&self, entries: &[Entry]) -> Vec<Vec<String>> {
    print(entries)
  }
}

fn local(module: &Module, path: &[&str]) -> String {
  module.import(path).map(|i| i.local().to_string()).unwrap_or_default()
}

fn nest(rows: Vec<Vec<&Token>>) -> Vec<Line<'_>> {
  fn under<'a>(rows: &[Vec<&'a Token>], at: &mut usize, column: Option<usize>) -> Vec<Line<'a>> {
    let mut lines = Vec::new();

    while let Some(row) = rows.get(*at).filter(|r| column.is_none_or(|c| r[0].column > c)) {
      *at += 1;
      lines.push(Line { tokens: row.clone(), children: under(rows, at, Some(row[0].column)) });
    }

    lines
  }

  under(&rows, &mut 0, None)
}

fn word(token: &Token) -> bool {
  let mut chars = token.text.chars();

  chars.next().is_some_and(|c| c.is_ascii_lowercase())
    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn adjacent(a: &Token, b: &Token) -> bool {
  a.span.end == b.span.start
}

fn joined(names: &[String], last: &str) -> String {
  let mut parts: Vec<&str> = names.iter().map(String::as_str).collect();

  parts.push(last);
  parts.join("_")
}

fn path(tokens: &[&Token], at: &mut usize) -> Result<Vec<Segment>, (Span, String)> {
  let Some(first) = tokens.get(*at).filter(|t| t.is("Slash")) else {
    let span = tokens.get(*at).map_or(tokens[0].span, |t| t.span);

    return Err((span, "a path starts with `/`".to_string()));
  };
  let mut segments = Vec::new();
  let mut slash = *first;
  let piece = |t: &Token| word(t) || t.is("Upper") || t.is("Int") || t.is("Minus");

  *at += 1;

  while let Some(next) = tokens.get(*at).copied().filter(|t| adjacent(slash, t)) {
    if next.is("Colon") {
      match tokens.get(*at + 1).filter(|t| adjacent(next, t) && word(t)) {
        Some(name) => segments.push(Segment::Param(name.text.clone())),
        None => return Err((next.span, "`:` names a parameter, like `:id`".to_string())),
      }

      *at += 2;
    } else if piece(next) {
      let mut text = next.text.clone();

      *at += 1;

      while let Some(more) = tokens.get(*at).filter(|t| adjacent(tokens[*at - 1], t) && piece(t)) {
        text.push_str(&more.text);
        *at += 1;
      }

      segments.push(Segment::Lit(text));
    } else {
      return Err((next.span, format!("`{}` can't appear in a path", next.text)));
    }

    match tokens.get(*at).copied().filter(|t| adjacent(tokens[*at - 1], t)) {
      Some(next) if next.is("Slash") => {
        slash = next;
        *at += 1;

        if !tokens.get(*at).is_some_and(|t| adjacent(slash, t)) {
          return Err((slash.span, "a path doesn't end in `/`".to_string()));
        }
      }
      Some(other) => return Err((other.span, format!("`{}` can't appear in a path", other.text))),
      None => break,
    }
  }

  match tokens.get(*at) {
    Some(next) if !next.is("Arrow") => {
      Err((next.span, "a path has no spaces in it".to_string()))
    }
    _ => Ok(segments),
  }
}

impl Walk<'_> {
  fn error(&mut self, span: Span, message: impl Into<String>, help: &str) {
    let mut diagnostic = Diagnostic::error(message, span);

    if !help.is_empty() {
      diagnostic = diagnostic.with_help(help.to_string());
    }

    self.out.error(diagnostic);
  }

  fn line(&mut self, line: &Line, scope: &Scope) {
    let head = line.tokens[0];
    let top = matches!(scope.place, Place::Top | Place::Namespace);

    match (head.text.as_str(), &scope.place) {
      ("root", _) if top => self.root(line, scope),
      ("namespace", _) if top => self.namespace(line, scope),
      ("resources", Place::Top | Place::Namespace | Place::Resources(_)) => {
        self.resources(line, scope);
      }
      ("member" | "collection", Place::Resources(resource)) => {
        self.block(line, scope, resource);
      }
      (verb, Place::Resources(_)) if VERBS.contains(&verb) => self.error(
        head.span,
        format!("a `{verb}` line inside `resources` goes in a `member` or `collection` block"),
        "`member` lines mount on `/posts/:id/…`, `collection` lines on `/posts/…`",
      ),
      (verb, _) if VERBS.contains(&verb) => self.verb(line, scope),
      ("member" | "collection", _) => self.error(
        head.span,
        format!("`{}` belongs inside a `resources` block", head.text),
        "indent it under a `resources` line",
      ),
      ("root" | "namespace" | "resources", _) => self.error(
        head.span,
        format!("`{}` can't go here", head.text),
        "`root` and `namespace` go at the top or in a `namespace`, and a `member` or \
         `collection` block holds only verb lines",
      ),
      _ => self.error(
        head.span,
        format!("`{}` is not a route", head.text),
        "a route starts with `root`, `get`, `post`, `put`, `patch`, `delete`, `resources` \
         or `namespace`",
      ),
    }
  }

  fn leaf(&mut self, line: &Line) -> bool {
    match line.children.first() {
      Some(child) => {
        self.error(
          child.span(),
          format!("nothing goes under a `{}` line", line.head()),
          "only `resources`, `namespace`, `member` and `collection` have lines under them",
        );
        false
      }
      None => true,
    }
  }

  fn end(&mut self, line: &Line, at: usize) -> bool {
    match line.tokens.get(at) {
      Some(extra) => {
        self.error(extra.span, format!("unexpected `{}`", extra.text), "");
        false
      }
      None => true,
    }
  }

  fn controller<'t>(
    &mut self,
    line: &Line<'t>,
    at: &mut usize,
    example: &str,
  ) -> Option<&'t Token> {
    let tokens = &line.tokens;
    let Some(arrow) = tokens.get(*at).filter(|t| t.is("Arrow")) else {
      let span = tokens.get(*at).map_or(line.span(), |t| t.span);

      self.error(span, format!("expected `{example}` here"), "");
      return None;
    };
    let Some(controller) = tokens.get(*at + 1).copied().filter(|t| t.is("Upper")) else {
      self.error(arrow.span, format!("expected a controller after `->`, like `{example}`"), "");
      return None;
    };

    *at += 2;

    if self.module.imports.iter().all(|i| i.local() != controller.text) {
      self.error(
        controller.span,
        format!("no module `{}` in `uses`", controller.text),
        "a controller is a module in `uses`, named by its last segment or its `as` alias",
      );
      return None;
    }

    Some(controller)
  }

  fn action(&mut self, line: &Line, at: &mut usize) -> Option<(String, String)> {
    let controller = self.controller(line, at, "-> PagesController.home")?;
    let tokens = &line.tokens;

    match (tokens.get(*at), tokens.get(*at + 1)) {
      (Some(dot), Some(name))
        if dot.is("Dot") && adjacent(controller, dot) && adjacent(dot, name) && word(name) =>
      {
        *at += 2;
        Some((controller.text.clone(), name.text.clone()))
      }
      _ => {
        self.error(
          controller.span,
          format!("`{}` needs an action, like `{}.show`", controller.text, controller.text),
          "",
        );
        None
      }
    }
  }

  fn add(
    &mut self,
    line: &Line,
    method: &'static str,
    segments: Vec<Segment>,
    (controller, action): (&str, &str),
    name: Option<String>,
  ) {
    self.routes.push(Route {
      span: line.span(),
      method,
      segments,
      controller: controller.to_string(),
      action: action.to_string(),
      name,
    });
  }

  fn root(&mut self, line: &Line, scope: &Scope) {
    let mut at = 1;
    let Some((controller, action)) = self.action(line, &mut at) else { return };

    if self.end(line, at) && self.leaf(line) {
      let name = joined(&scope.names, "root");

      self.add(line, "GET", scope.path.clone(), (&controller, &action), Some(name));
    }
  }

  fn verb(&mut self, line: &Line, scope: &Scope) {
    let method = match line.head() {
      "get" => "GET",
      "post" => "POST",
      "put" => "PUT",
      "patch" => "PATCH",
      _ => "DELETE",
    };
    let tokens = &line.tokens;
    let mut at = 1;
    let mut segments = scope.path.clone();

    if let Place::Block { .. } = scope.place {
      let Some(name) = tokens.get(1).filter(|t| word(t)) else {
        let span = tokens.get(1).map_or(line.span(), |t| t.span);

        self.error(span, format!("expected a name, like `{} publish -> …`", line.head()), "");
        return;
      };

      segments.push(Segment::Lit(name.text.clone()));
      at = 2;
    } else {
      match path(tokens, &mut at) {
        Ok(more) => segments.extend(more),
        Err((span, message)) => return self.error(span, message, PATH_HELP),
      }
    }

    let params: Vec<&str> = segments
      .iter()
      .filter_map(|s| match s {
        Segment::Param(name) => Some(name.as_str()),
        Segment::Lit(_) => None,
      })
      .collect();

    if let Some(twice) = params.iter().enumerate().find(|(i, p)| params[..*i].contains(p)) {
      let message = format!("the path has `:{}` twice", twice.1);

      return self.error(line.span(), message, "");
    }

    let Some((controller, action)) = self.action(line, &mut at) else { return };
    let name = match &scope.place {
      Place::Block { suffix } => {
        if !self.end(line, at) {
          return;
        }

        Some(format!("{}_{suffix}", tokens[1].text))
      }
      _ => match tokens.get(at) {
        None => None,
        Some(as_) if as_.text == "as" => match tokens.get(at + 1).filter(|t| word(t)) {
          Some(name) if self.end(line, at + 2) => Some(joined(&scope.names, &name.text)),
          Some(_) => return,
          None => return self.error(as_.span, "`as` needs a name, like `as about`", ""),
        },
        Some(_) => {
          self.end(line, at);
          return;
        }
      },
    };

    if self.leaf(line) {
      self.add(line, method, segments, (&controller, &action), name);
    }
  }

  fn namespace(&mut self, line: &Line, scope: &Scope) {
    let Some(name) = line.tokens.get(1).filter(|t| word(t)) else {
      let message = "`namespace` needs a name, like `namespace admin`";

      return self.error(line.tokens[0].span, message, "");
    };

    if !self.end(line, 2) {
      return;
    }

    let mut inner = scope.clone();

    inner.place = Place::Namespace;
    inner.path.push(Segment::Lit(name.text.clone()));
    inner.names.push(name.text.clone());

    for child in &line.children {
      self.line(child, &inner);
    }
  }

  fn block(&mut self, line: &Line, scope: &Scope, resource: &Resource) {
    if !self.end(line, 1) {
      return;
    }

    let (path, suffix) = if line.head() == "member" {
      (&resource.member_path, &resource.member_name)
    } else {
      (&resource.collection_path, &resource.collection_name)
    };
    let inner = Scope {
      place: Place::Block { suffix: suffix.clone() },
      path: path.clone(),
      names: scope.names.clone(),
    };

    for child in &line.children {
      if VERBS.contains(&child.head()) {
        self.line(child, &inner);
      } else {
        self.error(
          child.tokens[0].span,
          format!("a `{}` block holds verb lines, like `post publish -> …`", line.head()),
          "",
        );
      }
    }
  }

  fn options<'t>(
    &mut self,
    tokens: &[&'t Token],
    mut at: usize,
  ) -> Option<Options<'t>> {
    let mut alias = None;
    let mut filter: Option<(&Token, Vec<&Token>)> = None;

    while let Some(&option) = tokens.get(at) {
      at += 1;

      match option.text.as_str() {
        "as" => match tokens.get(at).filter(|t| word(t)) {
          Some(&name) => {
            alias = Some(name);
            at += 1;
          }
          None => {
            self.error(option.span, "`as` names the singular, like `as person`", "");
            return None;
          }
        },
        "only" | "except" => {
          if let Some((first, _)) = &filter {
            self.out.error(
              Diagnostic::error("use `only` or `except`, not both", option.span)
                .with_secondary(first.span, "already filtered here"),
            );
            return None;
          }

          let mut names = Vec::new();

          let option_word = |t: &&&Token| matches!(t.text.as_str(), "as" | "only" | "except");

          while let Some(&name) = tokens.get(at).filter(|t| !option_word(t)) {
            names.push(name);
            at += 1;
          }

          if names.is_empty() {
            let message = format!("`{0}` needs action names, like `{0} index show`", option.text);

            self.error(option.span, message, "");
            return None;
          }

          filter = Some((option, names));
        }
        _ => {
          self.error(
            option.span,
            format!("unexpected `{}`", option.text),
            "after the controller come `only …`, `except …` or `as …`",
          );
          return None;
        }
      }
    }

    Some((alias, filter))
  }

  fn resources(&mut self, line: &Line, scope: &Scope) {
    let tokens = &line.tokens;
    let Some(plural) = tokens.get(1).copied().filter(|t| word(t)) else {
      let message = "`resources` needs a name, like `resources posts`";

      return self.error(tokens[0].span, message, "");
    };
    let mut at = 2;
    let Some(controller) = self.controller(line, &mut at, "-> PostsController") else { return };
    let controller = controller.text.clone();
    let Some((alias, filter)) = self.options(tokens, at) else { return };
    let mut actions: Vec<&str> = ACTIONS.to_vec();

    if let Some((kind, names)) = &filter {
      let unknown: Vec<&&Token> =
        names.iter().filter(|n| !ACTIONS.contains(&n.text.as_str())).collect();

      for name in &unknown {
        self.error(
          name.span,
          format!("`{}` is not a resource action", name.text),
          "the actions are index, new, create, show, edit, update and destroy",
        );
      }

      if !unknown.is_empty() {
        return;
      }

      let listed = |a: &&str| names.iter().any(|n| n.text == *a);

      actions.retain(|a| listed(a) == (kind.text == "only"));
    }

    let one = match alias.map(|a| a.text.clone()).or_else(|| singular(&plural.text)) {
      Some(one) => one,
      None => {
        return self.error(
          plural.span,
          format!("can't tell the singular of `{}`", plural.text),
          &format!("name it with `as`, like `resources {} -> {controller} as person`", plural.text),
        );
      }
    };
    let under = |extra: &[Segment]| -> Vec<Segment> {
      let mut path = scope.path.clone();

      path.push(Segment::Lit(plural.text.clone()));
      path.extend(extra.iter().cloned());
      path
    };
    let id = || Segment::Param("id".to_string());
    let lit = |text: &str| Segment::Lit(text.to_string());
    let many = joined(&scope.names, &plural.text);
    let single = joined(&scope.names, &one);
    let expansion = [
      ("index", "GET", under(&[]), many.clone()),
      ("new", "GET", under(&[lit("new")]), format!("new_{single}")),
      ("create", "POST", under(&[]), many.clone()),
      ("show", "GET", under(&[id()]), single.clone()),
      ("edit", "GET", under(&[id(), lit("edit")]), format!("edit_{single}")),
      ("update", "PATCH", under(&[id()]), single.clone()),
      ("update", "PUT", under(&[id()]), single.clone()),
      ("destroy", "DELETE", under(&[id()]), single.clone()),
    ];
    let mut names = scope.names.clone();

    names.push(one.clone());

    let inner = Scope {
      place: Place::Resources(Resource {
        member_path: under(&[id()]),
        member_name: single.clone(),
        collection_path: under(&[]),
        collection_name: many.clone(),
      }),
      path: under(&[Segment::Param(format!("{one}_id"))]),
      names,
    };

    for child in &line.children {
      self.line(child, &inner);
    }

    let mut named: Vec<String> = Vec::new();

    for (action, method, segments, name) in expansion {
      if actions.contains(&action) {
        let name = (!named.contains(&name)).then_some(name);

        named.extend(name.clone());
        self.add(line, method, segments, (&controller, action), name);
      }
    }
  }

  fn duplicates(&mut self) {
    let mut reported: Vec<Span> = Vec::new();

    for (i, route) in self.routes.iter().enumerate() {
      let first = self.routes[..i]
        .iter()
        .find(|r| r.method == route.method && r.shape() == route.shape());

      if let Some(first) = first.filter(|_| !reported.contains(&route.span)) {
        reported.push(route.span);
        self.out.error(
          Diagnostic::error(
            format!("another `{}` route already matches `{}`", route.method, route.path()),
            route.span,
          )
          .with_secondary(first.span, "the first route"),
        );
      }
    }
  }

  fn helpers(&mut self) {
    let mut reported: Vec<Span> = Vec::new();

    for (i, route) in self.routes.iter().enumerate() {
      let Some(name) = &route.name else { continue };
      let first = self.routes[..i].iter().find(|r| r.name.as_ref() == Some(name));
      let helper = format!("{name}_path");

      if reported.contains(&route.span) {
        continue;
      }

      if let Some(first) = first {
        reported.push(route.span);
        self.out.error(
          Diagnostic::error(format!("`{helper}` is already generated"), route.span)
            .with_secondary(first.span, "by this route")
            .with_help("name one of them with `as`"),
        );
      } else if let Some(function) = self.module.function(&helper) {
        reported.push(route.span);
        self.out.error(
          Diagnostic::error(
            format!("this route generates `{helper}`, but the module has that function"),
            route.span,
          )
          .with_secondary(function.span, "the function"),
        );
      }
    }

    for name in ["router", "route_table"] {
      if let Some(function) = self.module.function(name) {
        self.error(
          function.span,
          format!("the `routes` zone generates `{name}`, so this module can't declare it"),
          "",
        );
      }
    }
  }
}

fn quoted(text: &str) -> String {
  format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn table(routes: &[Route], zone: Span) -> Generated {
  let mut source = Source::new();

  source.push(
    "route_table: List<{ method: String, path: String, action: String, name: String }> = [",
  );

  for route in routes {
    source.push(&format!(
      "\n  {{ method: {}, path: {}, action: {}, name: {} }},",
      quoted(route.method),
      quoted(&route.path()),
      quoted(&format!("{}.{}", route.controller, route.action)),
      quoted(route.name.as_deref().unwrap_or_default()),
    ));
  }

  source.push("\n]");
  source.finish("constants", zone)
}

fn router(routes: &[Route], conn: &str, zone: Span) -> Generated {
  let mut chain = String::from("None");

  for i in (0..routes.len()).rev() {
    chain = format!(
      "match router_route_{i}(conn, method) {{\n    Some(response) -> Some(response),\n    \
       None -> {},\n  }}",
      chain.replace('\n', "\n  ")
    );
  }

  let mut allowed = String::from("  let allowed = []\n");

  for (i, route) in routes.iter().enumerate().rev() {
    allowed.push_str(&format!(
      "  let allowed = if router_path_{i}(segments) {{ [\"{}\", ..allowed] }} else {{ allowed }}\n",
      route.method
    ));
  }

  let mut source = Source::new();

  source.push(&format!(
    "router(request: Request) {{\n  \
       let conn = {conn}.with_method_override({conn}.from_request(request))\n\n  \
       match router_match(conn, {conn}.routing_method(conn)) {{\n    \
         Some(response) -> Some({conn}.for_head(conn, response)),\n    \
         None -> {conn}.method_not_allowed(router_allowed(conn.segments)),\n  \
       }}\n\
     }}\n\n\
     router_match(conn: Conn, method: String) {{\n  {chain}\n}}\n\n\
     router_allowed(segments: List<String>) -> List<String> {{\n{allowed}\n  allowed\n}}"
  ));
  source.finish("functions", zone)
}

fn pattern(route: &Route, bind: bool) -> String {
  let parts: Vec<String> = route
    .segments
    .iter()
    .enumerate()
    .map(|(i, s)| match s {
      Segment::Lit(text) => quoted(text),
      Segment::Param(_) if bind => format!("segment_{i}"),
      Segment::Param(_) => "_".to_string(),
    })
    .collect();

  format!("[{}]", parts.join(", "))
}

fn try_route(index: usize, route: &Route, conn: &str) -> Generated {
  let mut with_params = "conn".to_string();

  for (i, segment) in route.segments.iter().enumerate().rev() {
    if let Segment::Param(name) = segment {
      with_params = format!("{conn}.with_path_param({with_params}, \"{name}\", segment_{i})");
    }
  }

  let mut source = Source::new();

  source
    .push(&format!(
      "router_route_{index}(conn: Conn, method: String) {{\n  \
         if method == \"{}\" {{\n    match conn.segments {{\n      {} -> {{\n        \
           let response: Response = {conn}.rescue_halt(function() {{ ",
      route.method,
      pattern(route, true),
    ))
    .from(route.span, &format!("{}.{}({with_params})", route.controller, route.action))
    .push(&format!(
      " }})\n\n        Some(response)\n      }},\n      _ -> None,\n    }}\n  \
       }} else {{\n    None\n  }}\n}}\n\n\
       router_path_{index}(segments: List<String>) -> Bool {{\n  \
         match segments {{\n    {} -> true,\n    _ -> false,\n  }}\n}}",
      pattern(route, false),
    ));
  source.finish("functions", route.span)
}

const PATHS: &str = "Paths";

fn paths(routes: &[Route]) -> Option<String> {
  let named: Vec<(&String, &Route)> =
    routes.iter().filter_map(|r| r.name.as_ref().map(|n| (n, r))).collect();

  if named.is_empty() {
    return None;
  }

  let mut functions = Vec::new();
  let mut exports = Vec::new();

  for (name, route) in &named {
    let source = helper(name, route, "Conn", "Id").source;

    functions.push(format!("  {}", source.replace('\n', "\n  ")));
    exports.push(format!("  {name}_path"));
  }

  exports.sort();

  Some(format!(
    "module {PATHS}\n\nuses\n  Std.Id\n  Ticket.Conn\n\nfunctions\n{}\n\nexports\n{}\n",
    functions.join("\n\n"),
    exports.join("\n"),
  ))
}

fn helper(name: &str, route: &Route, conn: &str, id: &str) -> Generated {
  let vars = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let mut ids = 0;
  let params: Vec<String> = route
    .params()
    .iter()
    .map(|p| {
      if *p == "id" || p.ends_with("_id") {
        ids += 1;
        format!("{p}: Id<{}>", vars.get(ids - 1).map_or(format!("t{ids}"), ToString::to_string))
      } else {
        format!("{p}: String")
      }
    })
    .collect();
  let path: String = if route.segments.is_empty() {
    "/".to_string()
  } else {
    route
      .segments
      .iter()
      .map(|s| match s {
        Segment::Lit(text) => format!("/{text}"),
        Segment::Param(p) if p == "id" || p.ends_with("_id") => format!("/#{{{id}.value({p})}}"),
        Segment::Param(p) => format!("/#{{{conn}.path_segment({p})}}"),
      })
      .collect()
  };
  let mut source = Source::new();

  source.push(&format!("{name}_path({}) -> String {{\n  \"{path}\"\n}}", params.join(", ")));
  source.finish("functions", route.span)
}

struct Row {
  depth: usize,
  verb: Option<String>,
  head: String,
  target: Option<String>,
  tail: Option<String>,
  comment: Option<String>,
  breaks: bool,
}

fn spaced(tokens: &[&Token]) -> String {
  let mut text = String::new();

  for (i, token) in tokens.iter().enumerate() {
    if i > 0 && !adjacent(tokens[i - 1], token) {
      text.push(' ');
    }

    text.push_str(&token.text);
  }

  text
}

fn row(tokens: &[&Token], depth: usize, breaks: bool) -> Row {
  let plain = |depth| Row {
    depth,
    verb: None,
    head: spaced(tokens),
    target: None,
    tail: None,
    comment: None,
    breaks,
  };
  let Some(arrow) = tokens.iter().position(|t| t.is("Arrow")) else {
    return plain(depth);
  };

  if arrow == 0
    || arrow + 1 == tokens.len()
    || adjacent(tokens[arrow - 1], tokens[arrow])
    || adjacent(tokens[arrow], tokens[arrow + 1])
  {
    return plain(depth);
  }

  let (head, rest) = tokens.split_at(arrow);
  let verb = (head.len() > 1
    && VERBS.contains(&head[0].text.as_str())
    && !adjacent(head[0], head[1]))
  .then(|| head[0].text.clone());
  let head_text = if verb.is_some() { spaced(&head[1..]) } else { spaced(head) };
  let mut end = 2;

  while end < rest.len() && adjacent(rest[end - 1], rest[end]) {
    end += 1;
  }

  let tail = (end < rest.len()).then(|| spaced(&rest[end..]));
  let target = Some(format!("-> {}", spaced(&rest[1..end])));

  Row { depth, verb, head: head_text, target, tail, comment: None, breaks }
}

fn print(entries: &[Entry]) -> Vec<Vec<String>> {
  let mut rows: Vec<Vec<Row>> = Vec::new();
  let mut last_line: Option<usize> = None;

  for entry in entries {
    let lines = entry.lines();
    let mut columns: Vec<usize> = lines
      .iter()
      .map(|l| l[0].column)
      .chain(entry.comments.iter().map(|c| c.column))
      .collect();

    columns.sort_unstable();
    columns.dedup();

    let depth = |column: usize| columns.iter().position(|c| *c == column).unwrap_or(0);
    let mut printed: Vec<(usize, Row)> = Vec::new();

    for line in &lines {
      printed.push((line[0].line, row(line, depth(line[0].column), false)));
    }

    for comment in &entry.comments {
      match printed.iter_mut().find(|(line, _)| *line == comment.line) {
        Some((_, row)) => row.comment = Some(comment.text.clone()),
        None => printed.push((
          comment.line,
          Row {
            depth: depth(comment.column),
            verb: None,
            head: comment.text.clone(),
            target: None,
            tail: None,
            comment: None,
            breaks: false,
          },
        )),
      }
    }

    printed.sort_by_key(|(line, _)| *line);

    if let (Some(last), Some((first, row))) = (last_line, printed.first_mut()) {
      row.breaks = *first > last + 1;
    }

    last_line = printed.last().map(|(line, _)| *line);
    rows.push(printed.into_iter().map(|(_, row)| row).collect());
  }

  let flat: Vec<&Row> = rows.iter().flatten().collect();
  let mut widths: Vec<(usize, usize, usize)> = vec![(0, 0, 0); flat.len()];
  let mut start = 0;

  for end in 1..=flat.len() {
    if end < flat.len() && !flat[end].breaks {
      continue;
    }

    let block = &flat[start..end];
    let verb = block.iter().filter_map(|r| r.verb.as_ref().map(String::len)).max().unwrap_or(0);
    let left = |r: &Row| {
      2 * r.depth + r.verb.as_ref().map_or(0, |_| verb + 2) + r.head.len()
    };
    let arrow = block.iter().filter(|r| r.target.is_some()).map(|r| left(r)).max().unwrap_or(0);
    let target = block
      .iter()
      .filter(|r| r.tail.is_some())
      .filter_map(|r| r.target.as_ref().map(String::len))
      .max()
      .unwrap_or(0);

    for slot in &mut widths[start..end] {
      *slot = (verb, arrow, target);
    }

    start = end;
  }

  let mut i = 0;

  rows
    .iter()
    .map(|entry| {
      entry
        .iter()
        .map(|r| {
          let (verb, arrow, target) = widths[i];
          let mut line = "  ".repeat(r.depth);

          i += 1;

          if let Some(v) = &r.verb {
            line.push_str(&format!("{v:verb$}  "));
          }

          line.push_str(&r.head);

          if let Some(t) = &r.target {
            let pad = arrow - (line.len());

            line.push_str(&" ".repeat(pad + 2));

            match &r.tail {
              Some(tail) => line.push_str(&format!("{t:target$}  {tail}")),
              None => line.push_str(t),
            }
          }

          if let Some(comment) = &r.comment {
            line.push_str(&format!("  {comment}"));
          }

          line
        })
        .collect()
    })
    .collect()
}
