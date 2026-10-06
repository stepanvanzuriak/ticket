use polar_plugin::{Diagnostic, Entry, Expansion, Module, Source, Span, Token, Zone, ZonePlugin};

pub struct Views;

pub struct Components;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
  View,
  Component,
}

impl Kind {
  fn keyword(self) -> &'static str {
    match self {
      Kind::View => "views",
      Kind::Component => "view_component",
    }
  }

  fn noun(self) -> &'static str {
    match self {
      Kind::View => "view",
      Kind::Component => "component",
    }
  }

  fn example(self) -> &'static str {
    match self {
      Kind::View => "card(post: Post)",
      Kind::Component => "Button(label: String)",
    }
  }
}

const VOID: [&str; 13] = [
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
  "wbr",
];

struct View<'a> {
  entry: &'a Entry,
  kind: Kind,
  name: String,
  written: String,
  name_span: Span,
  params: Vec<String>,
  params_span: Option<Span>,
  body: Vec<&'a Token>,
}

enum Chunk {
  Plain(String),
  From(Span, String),
}

enum Piece {
  Static(String),
  Code(Vec<Chunk>),
}

struct Attr {
  name: String,
  span: Span,
  value: Option<Value>,
}

enum Value {
  Text(String),
  Code(Span, String),
}

struct Parser<'a, 'b> {
  entry: &'a Entry,
  tokens: &'b [&'a Token],
  at: usize,
  last: usize,
  html: &'b str,
  views: &'b [View<'a>],
  module: &'b Module,
  out: &'b mut Expansion,
}

impl ZonePlugin for Views {
  fn zone(&self) -> Zone {
    zone(Kind::View)
  }

  fn expand(&self, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
    expand(Kind::View, zone, entries, module)
  }
}

impl ZonePlugin for Components {
  fn zone(&self) -> Zone {
    zone(Kind::Component)
  }

  fn expand(&self, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
    expand(Kind::Component, zone, entries, module)
  }
}

fn zone(kind: Kind) -> Zone {
  Zone {
    keyword: kind.keyword().to_string(),
    after: "binds".to_string(),
    blank_between_entries: true,
  }
}

fn expand(kind: Kind, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
  let mut out = Expansion::default();
  let Some(import) = module.import(&["Ticket", "Html"]) else {
    out.error(
      Diagnostic::error(format!("the `{}` zone needs `Ticket.Html`", kind.keyword()), zone)
        .with_help("add `Ticket.Html` to the `uses` zone"),
    );
    return out;
  };
  let html = import.local().to_string();
  let views: Vec<View> = entries.iter().filter_map(|e| view(kind, e, &mut out)).collect();

  for (i, view) in views.iter().enumerate() {
    if let Some(first) = views[..i].iter().find(|v| v.name == view.name) {
      out.error(
        Diagnostic::error(
          format!("the {} `{}` is declared more than once", kind.noun(), view.written),
          view.name_span,
        )
        .with_secondary(first.name_span, "first declared here"),
      );
    } else if let Some(function) = module.function(&view.name) {
      out.error(
        Diagnostic::error(
          format!("there is already a function `{}` in this module", view.name),
          view.name_span,
        )
        .with_secondary(function.span, "the function"),
      );
    }
  }

  if out.has_errors() {
    return out;
  }

  let mut generated = Vec::new();

  for view in &views {
    let mut parser = Parser {
      entry: view.entry,
      tokens: &view.body,
      at: 0,
      last: view.body[0].span.start,
      html: &html,
      views: &views,
      module,
      out: &mut out,
    };

    if let Some(pieces) = parser.children(None) {
      generated.push(function(view, &html, pieces));
    }
  }

  if !out.has_errors() {
    for generated in generated {
      out.emit(generated);
    }
  }

  out
}

fn word(token: &Token) -> bool {
  let mut chars = token.text.chars();

  chars.next().is_some_and(|c| c.is_ascii_alphabetic())
    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn adjacent(a: &Token, b: &Token) -> bool {
  a.span.end == b.span.start
}

fn view<'a>(kind: Kind, entry: &'a Entry, out: &mut Expansion) -> Option<View<'a>> {
  let lines = entry.lines();
  let header = &lines[0];
  let noun = kind.noun();
  let help = format!(
    "write a {noun} like `{}`, with its markup on the lines below",
    kind.example()
  );
  let bad = |out: &mut Expansion, span: Span, message: &str| {
    out.error(Diagnostic::error(message.to_string(), span).with_help(help.clone()));
  };

  let name = header[0];

  if kind == Kind::View && !name.is("Lower") {
    bad(out, name.span, "a view starts with its name");
    return None;
  }

  if kind == Kind::Component && !name.is("Upper") {
    bad(out, name.span, "a component starts with its name, in PascalCase");
    return None;
  }

  let (Some(open), Some(close)) = (header.get(1), header.last()) else {
    bad(out, name.span, &format!("a {noun}'s name is followed by its parameters"));
    return None;
  };

  if !open.is("LParen") || !close.is("RParen") || header.len() < 3 {
    bad(out, open.span, &format!("a {noun}'s name is followed by its parameters, alone on the line"));
    return None;
  }

  let inside = &header[2..header.len() - 1];
  let mut params = Vec::new();
  let mut depth = 0i32;
  let mut expect_name = true;

  for token in inside {
    match token.kind.as_str() {
      "LParen" | "Lt" | "LBrace" | "LBracket" => depth += 1,
      "RParen" | "Gt" | "RBrace" | "RBracket" => depth -= 1,
      "Comma" if depth == 0 => {
        expect_name = true;
        continue;
      }
      _ => {}
    }

    if expect_name {
      if !token.is("Lower") {
        bad(out, token.span, "a parameter starts with its name");
        return None;
      }

      params.push(token.text.clone());
      expect_name = false;
    }
  }

  let body: Vec<&Token> = lines[1..].iter().flatten().copied().collect();

  if body.is_empty() {
    out.error(
      Diagnostic::error(format!("the {noun} `{}` has no markup", name.text), name.span)
        .with_help("write its markup on the lines below, indented"),
    );
    return None;
  }

  Some(View {
    entry,
    kind,
    name: match kind {
      Kind::View => name.text.clone(),
      Kind::Component => snake(&name.text),
    },
    written: name.text.clone(),
    name_span: name.span,
    params,
    params_span: inside.first().map(|first| first.span.join(inside[inside.len() - 1].span)),
    body,
  })
}

fn clean(text: &str) -> String {
  let lines: Vec<&str> = text.split('\n').collect();
  let count = lines.len();
  let mut kept = Vec::new();

  for (i, line) in lines.iter().enumerate() {
    let mut line = *line;

    if i > 0 {
      line = line.trim_start();
    }

    if i + 1 < count {
      line = line.trim_end();
    }

    if !line.is_empty() {
      kept.push(line);
    }
  }

  kept.join(" ")
}

fn literal(text: &str) -> String {
  let escaped = text
    .replace('\\', "\\\\")
    .replace('"', "\\\"")
    .replace('#', "\\#")
    .replace('\n', "\\n");

  format!("\"{escaped}\"")
}

fn snake(pascal: &str) -> String {
  let mut out = String::new();

  for (i, c) in pascal.chars().enumerate() {
    if c.is_ascii_uppercase() {
      if i > 0 {
        out.push('_');
      }

      out.push(c.to_ascii_lowercase());
    } else {
      out.push(c);
    }
  }

  out
}

fn push_static(pieces: &mut Vec<Piece>, text: &str) {
  if text.is_empty() {
    return;
  }

  if let Some(Piece::Static(last)) = pieces.last_mut() {
    last.push_str(text);
  } else {
    pieces.push(Piece::Static(text.to_string()));
  }
}

fn list(pieces: Vec<Piece>, html: &str) -> Vec<Chunk> {
  let mut chunks = vec![Chunk::Plain("[".to_string())];

  for (i, piece) in pieces.into_iter().enumerate() {
    if i > 0 {
      chunks.push(Chunk::Plain(", ".to_string()));
    }

    match piece {
      Piece::Static(text) => chunks.push(Chunk::Plain(literal(&text))),
      Piece::Code(code) => {
        chunks.push(Chunk::Plain(format!("{html}.piece(")));
        chunks.extend(code);
        chunks.push(Chunk::Plain(")".to_string()));
      }
    }
  }

  chunks.push(Chunk::Plain("]".to_string()));
  chunks
}

fn concat(pieces: Vec<Piece>, html: &str) -> Vec<Chunk> {
  let mut chunks = vec![Chunk::Plain(format!("{html}.concat("))];

  chunks.extend(list(pieces, html));
  chunks.push(Chunk::Plain(")".to_string()));
  chunks
}

fn write(source: &mut Source, chunks: Vec<Chunk>) {
  for chunk in chunks {
    match chunk {
      Chunk::Plain(text) => source.push(&text),
      Chunk::From(span, text) => source.from(span, &text),
    };
  }
}

fn function(view: &View, html: &str, pieces: Vec<Piece>) -> polar_plugin::Generated {
  let mut source = Source::new();

  source.from(view.name_span, &view.name).push("(");

  if view.kind == Kind::Component {
    source.push("props: {");

    if let Some(span) = view.params_span {
      source.push(" ").from(span, view.entry.text(span)).push(" ");
    }

    source.push("}) {\n");

    for param in &view.params {
      source.push(&format!("  let {param} = props.{param}\n"));
    }

    source.push("  ");
  } else {
    if let Some(span) = view.params_span {
      source.from(span, view.entry.text(span));
    }

    source.push(") {\n  ");
  }

  write(&mut source, concat(pieces, html));
  source.push("\n}");
  source.finish("functions", view.name_span)
}

impl<'a> Parser<'a, '_> {
  fn peek(&self, offset: usize) -> Option<&'a Token> {
    self.tokens.get(self.at + offset).copied()
  }

  fn error(&mut self, diagnostic: Diagnostic) -> Option<Vec<Piece>> {
    self.out.error(diagnostic);
    None
  }

  fn text_until(&mut self, end: usize, pieces: &mut Vec<Piece>) {
    let mut raw = String::new();
    let mut from = self.last;

    for comment in &self.entry.comments {
      if comment.span.start >= from && comment.span.end <= end {
        raw.push_str(self.entry.text(Span { start: from, end: comment.span.start }));
        from = comment.span.end;
      }
    }

    raw.push_str(self.entry.text(Span { start: from, end }));
    push_static(pieces, &clean(&raw));
  }

  fn children(&mut self, parent: Option<(&str, Span)>) -> Option<Vec<Piece>> {
    let mut pieces = Vec::new();

    loop {
      let Some(token) = self.peek(0) else {
        let end = self.tokens.last().map_or(self.last, |t| t.span.end);

        self.text_until(end, &mut pieces);

        return match parent {
          Some((name, span)) => self.error(
            Diagnostic::error(format!("`<{name}>` is never closed"), span)
              .with_help(format!("close it with `</{name}>`")),
          ),
          None => Some(pieces),
        };
      };

      match token.kind.as_str() {
        "Lt" => {
          self.text_until(token.span.start, &mut pieces);

          if self.peek(1).is_some_and(|t| t.is("Slash")) {
            return self.close(token, parent, pieces);
          }

          self.element(&mut pieces)?;
        }
        "LBrace" => {
          self.text_until(token.span.start, &mut pieces);

          let (span, text) = self.braces()?;

          pieces.push(Piece::Code(vec![Chunk::From(span, text)]));
        }
        _ => self.at += 1,
      }
    }
  }

  fn close(
    &mut self,
    open: &'a Token,
    parent: Option<(&str, Span)>,
    pieces: Vec<Piece>,
  ) -> Option<Vec<Piece>> {
    let name = self.name(2);
    let end = self.peek(2 + name.as_ref().map_or(0, |(_, count, _)| *count));
    let Some(((text, count, _), end)) = name.zip(end.filter(|t| t.is("Gt"))) else {
      return self.error(
        Diagnostic::error("expected a closing tag like `</div>`", open.span)
          .with_help("a closing tag is `</` then the tag's name then `>`"),
      );
    };
    let span = open.span.join(end.span);

    match parent {
      Some((expected, _)) if expected == text => {
        self.at += 3 + count;
        self.last = end.span.end;
        Some(pieces)
      }
      Some((expected, opened)) => self.error(
        Diagnostic::error(format!("`</{text}>` closes `<{expected}>`"), span)
          .with_secondary(opened, "opened here")
          .with_help(format!("close it with `</{expected}>`")),
      ),
      None => self.error(Diagnostic::error(format!("`</{text}>` closes nothing"), span)),
    }
  }

  fn name(&self, offset: usize) -> Option<(String, usize, Span)> {
    let first = self.peek(offset).filter(|t| word(t))?;
    let mut text = first.text.clone();
    let mut span = first.span;
    let mut count = 1;

    while let (Some(sep), Some(next)) = (self.peek(offset + count), self.peek(offset + count + 1)) {
      let qualifies = sep.is("Dot")
        && next.is("Upper")
        && text.starts_with(|c: char| c.is_ascii_uppercase());
      let joins = (sep.is("Minus") || sep.is("Colon") || qualifies)
        && word(next)
        && span.end == sep.span.start
        && adjacent(sep, next);

      if !joins {
        break;
      }

      text.push_str(&sep.text);
      text.push_str(&next.text);
      span = span.join(next.span);
      count += 2;
    }

    Some((text, count, span))
  }

  fn braces(&mut self) -> Option<(Span, String)> {
    let open = self.peek(0)?;
    let mut depth = 0;
    let mut offset = 0;

    loop {
      let Some(token) = self.peek(offset) else {
        self.out.error(
          Diagnostic::error("this `{` is never closed", open.span)
            .with_help("an expression in markup is written `{post.title}`"),
        );
        return None;
      };

      match token.kind.as_str() {
        "LBrace" => depth += 1,
        "RBrace" => {
          depth -= 1;

          if depth == 0 {
            break;
          }
        }
        _ => {}
      }

      offset += 1;
    }

    let close = self.peek(offset)?;

    self.at += offset + 1;
    self.last = close.span.end;

    if offset == 1 {
      self.out.error(
        Diagnostic::error("`{}` has no expression in it", open.span.join(close.span))
          .with_help("write an expression, like `{post.title}`"),
      );
      return None;
    }

    let span = Span { start: open.span.end, end: close.span.start };

    Some((span, self.entry.text(span).trim().to_string()))
  }

  fn attrs(&mut self) -> Option<(Vec<Attr>, bool)> {
    let mut attrs = Vec::new();

    loop {
      let token = self.peek(0)?;

      if token.is("Gt") {
        self.at += 1;
        self.last = token.span.end;
        return Some((attrs, false));
      }

      if token.is("Slash") && self.peek(1).is_some_and(|t| t.is("Gt") && adjacent(token, t)) {
        let gt = self.peek(1)?;

        self.at += 2;
        self.last = gt.span.end;
        return Some((attrs, true));
      }

      let Some((name, count, span)) = self.name(0) else {
        self.out.error(
          Diagnostic::error(format!("`{}` can't appear in a tag", token.text), token.span)
            .with_help("a tag holds attributes like `class=\"card\"` or `href={url}`"),
        );
        return None;
      };

      self.at += count;

      if !self.peek(0).is_some_and(|t| t.is("Eq")) {
        attrs.push(Attr { name, span, value: None });
        continue;
      }

      let eq = self.peek(0)?;

      self.at += 1;

      let value = match self.peek(0) {
        Some(t) if t.is("LBrace") => {
          let (span, text) = self.braces()?;

          Value::Code(span, text)
        }
        Some(t) if t.is("StringStart") => self.string()?,
        _ => {
          self.out.error(
            Diagnostic::error(format!("`{name}=` needs a value"), eq.span)
              .with_help(format!("write `{name}=\"…\"` or `{name}={{expression}}`")),
          );
          return None;
        }
      };

      attrs.push(Attr { name, span, value: Some(value) });
    }
  }

  fn string(&mut self) -> Option<Value> {
    let open = self.peek(0)?;
    let mut offset = 1;
    let mut plain = true;

    loop {
      let token = self.peek(offset)?;

      match token.kind.as_str() {
        "StringEnd" => break,
        "StringPart" if !token.text.contains('\\') => {}
        _ => plain = false,
      }

      offset += 1;
    }

    let close = self.peek(offset)?;
    let span = open.span.join(close.span);

    self.at += offset + 1;
    self.last = close.span.end;

    let text = self.entry.text(span);

    Some(if plain {
      Value::Text(text[1..text.len() - 1].to_string())
    } else {
      Value::Code(span, text.to_string())
    })
  }

  fn element(&mut self, pieces: &mut Vec<Piece>) -> Option<()> {
    let lt = self.peek(0)?;
    let Some((name, count, name_span)) = self.name(1) else {
      self.out.error(
        Diagnostic::error("`<` starts a tag, so a tag name goes after it", lt.span)
          .with_help("write `{\"<\"}` for a literal `<`"),
      );
      return None;
    };

    self.at += 1 + count;

    let open_span = lt.span.join(name_span);
    let Some((attrs, closed)) = self.attrs() else {
      if self.peek(0).is_none() {
        self.out.error(
          Diagnostic::error(format!("`<{name}` is never finished"), open_span)
            .with_help("finish the tag with `>` or `/>`"),
        );
      }
      return None;
    };

    if name.starts_with(|c: char| c.is_ascii_uppercase()) {
      return self.component(&name, open_span, attrs, closed, pieces);
    }

    push_static(pieces, &format!("<{name}"));

    for attr in attrs {
      match attr.value {
        None => push_static(pieces, &format!(" {}", attr.name)),
        Some(Value::Text(text)) => {
          push_static(pieces, &format!(" {}=\"{text}\"", attr.name));
        }
        Some(Value::Code(span, text)) => {
          pieces.push(Piece::Code(vec![
            Chunk::Plain(format!("{}.attr({}, ", self.html, literal(&attr.name))),
            Chunk::From(span, text),
            Chunk::Plain(")".to_string()),
          ]));
        }
      }
    }

    push_static(pieces, ">");

    let void = VOID.contains(&name.as_str());

    if closed {
      if !void {
        push_static(pieces, &format!("</{name}>"));
      }
      return Some(());
    }

    let children = self.children(Some((&name, open_span)))?;

    if void && !children.is_empty() {
      self.out.error(
        Diagnostic::error(format!("`<{name}>` can't have children"), open_span)
          .with_help(format!("write it as `<{name} />`")),
      );
      return None;
    }

    for child in children {
      match child {
        Piece::Static(text) => push_static(pieces, &text),
        code => pieces.push(code),
      }
    }

    if !void {
      push_static(pieces, &format!("</{name}>"));
    }

    Some(())
  }

  fn component(
    &mut self,
    name: &str,
    span: Span,
    attrs: Vec<Attr>,
    closed: bool,
    pieces: &mut Vec<Piece>,
  ) -> Option<()> {
    if let Some((module, tag)) = name.split_once('.') {
      return self.qualified(name, module, tag, span, attrs, closed, pieces);
    }

    let function = snake(name);
    let params: Vec<String> = match self.views.iter().find(|v| v.name == function) {
      Some(view) if view.kind == Kind::Component => {
        let params = view.params.clone();

        return self.props(name, function, Some(&params), span, attrs, closed, pieces);
      }
      Some(view) => view.params.clone(),
      None => match self.module.function(&function) {
        Some(f) => f.params.iter().map(|p| p.name.clone()).collect(),
        None => return self.props(name, function, None, span, attrs, closed, pieces),
      },
    };

    for attr in &attrs {
      if attr.name == "children" || !params.contains(&attr.name) {
        self.out.error(
          Diagnostic::error(format!("`{function}` has no parameter `{}`", attr.name), attr.span)
            .with_help(format!("its parameters are {}", params.join(", "))),
        );
      }
    }

    let children = if closed { None } else { Some(self.children(Some((name, span)))?) };

    if children.is_some() && !params.iter().any(|p| p == "children") {
      self.out.error(
        Diagnostic::error(format!("`<{name}>` has children, but `{function}` takes none"), span)
          .with_help(format!("give `{function}` a `children: Html` parameter, or write `<{name} />`")),
      );
    }

    let mut chunks = vec![Chunk::Plain(format!("{function}("))];
    let mut children = children;

    for (i, param) in params.iter().enumerate() {
      if i > 0 {
        chunks.push(Chunk::Plain(", ".to_string()));
      }

      if param == "children" {
        chunks.extend(concat(children.take().unwrap_or_default(), self.html));
        continue;
      }

      match attrs.iter().find(|a| a.name == *param).map(|a| &a.value) {
        Some(Some(Value::Code(span, text))) => chunks.push(Chunk::From(*span, text.clone())),
        Some(Some(Value::Text(text))) => chunks.push(Chunk::Plain(literal(text))),
        Some(None) => chunks.push(Chunk::Plain("true".to_string())),
        None => {
          self.out.error(
            Diagnostic::error(format!("`<{name}>` needs `{param}`"), span)
              .with_help(format!("pass it like `{param}={{…}}`")),
          );
          return None;
        }
      }
    }

    chunks.push(Chunk::Plain(")".to_string()));
    pieces.push(Piece::Code(chunks));

    if self.out.has_errors() { None } else { Some(()) }
  }

  #[allow(clippy::too_many_arguments)]
  fn qualified(
    &mut self,
    name: &str,
    module: &str,
    tag: &str,
    span: Span,
    attrs: Vec<Attr>,
    closed: bool,
    pieces: &mut Vec<Piece>,
  ) -> Option<()> {
    if tag.contains('.') {
      self.out.error(
        Diagnostic::error(format!("`<{name}>` names a component through more than one module"), span)
          .with_help("write `<Module.Component>`, with the module's name from the `uses` zone"),
      );
      return None;
    }

    if !self.module.imports.iter().any(|i| i.local() == module) {
      self.out.error(
        Diagnostic::error(format!("`<{name}>` needs the module `{module}`, which isn't imported"), span)
          .with_help(format!("add `{module}` to the `uses` zone")),
      );
      return None;
    }

    let function = format!("{module}.{}", snake(tag));

    self.props(name, function, None, span, attrs, closed, pieces)
  }

  #[allow(clippy::too_many_arguments)]
  fn props(
    &mut self,
    name: &str,
    function: String,
    params: Option<&[String]>,
    span: Span,
    attrs: Vec<Attr>,
    closed: bool,
    pieces: &mut Vec<Piece>,
  ) -> Option<()> {
    for attr in &attrs {
      let known = params.is_none_or(|params| params.contains(&attr.name));

      if attr.name == "children" || !known {
        let help = match params {
          Some(params) => format!("its props are {}", params.join(", ")),
          None => "write children between the tags".to_string(),
        };

        self.out.error(
          Diagnostic::error(format!("`<{name}>` has no prop `{}`", attr.name), attr.span)
            .with_help(help),
        );
      } else if attr.name.contains(['-', ':']) {
        self.out.error(
          Diagnostic::error(format!("`{}` can't be a prop", attr.name), attr.span)
            .with_help("a prop is one of the component's parameters, like `label={…}`"),
        );
      }
    }

    let takes_children = params.map(|params| params.iter().any(|p| p == "children"));

    if let Some(params) = params {
      for param in params {
        if param != "children" && !attrs.iter().any(|a| a.name == *param) {
          self.out.error(
            Diagnostic::error(format!("`<{name}>` needs `{param}`"), span)
              .with_help(format!("pass it like `{param}={{…}}`")),
          );
        }
      }
    }

    let children = if closed { None } else { Some(self.children(Some((name, span)))?) };

    if children.is_some() && takes_children == Some(false) {
      self.out.error(
        Diagnostic::error(format!("`<{name}>` has children, but `{function}` takes none"), span)
          .with_help(format!("give `{name}` a `children: Html` parameter, or write `<{name} />`")),
      );
    }

    if self.out.has_errors() {
      return None;
    }

    let children = children.or_else(|| takes_children.unwrap_or(false).then(Vec::new));
    let mut fields: Vec<Vec<Chunk>> = Vec::new();

    for attr in attrs {
      let mut field = vec![Chunk::Plain(format!("{}: ", attr.name))];

      match attr.value {
        Some(Value::Code(span, text)) => field.push(Chunk::From(span, text)),
        Some(Value::Text(text)) => field.push(Chunk::Plain(literal(&text))),
        None => field.push(Chunk::Plain("true".to_string())),
      }

      fields.push(field);
    }

    if let Some(children) = children {
      let mut field = vec![Chunk::Plain("children: ".to_string())];

      field.extend(concat(children, self.html));
      fields.push(field);
    }

    let empty = fields.is_empty();
    let mut chunks = vec![
      Chunk::From(span, function),
      Chunk::Plain("(".to_string()),
      Chunk::From(span, "{".to_string()),
    ];

    for (i, field) in fields.into_iter().enumerate() {
      chunks.push(Chunk::Plain(if i == 0 { " " } else { ", " }.to_string()));
      chunks.extend(field);
    }

    if !empty {
      chunks.push(Chunk::Plain(" ".to_string()));
    }

    chunks.push(Chunk::From(span, "}".to_string()));
    chunks.push(Chunk::Plain(")".to_string()));
    pieces.push(Piece::Code(chunks));

    Some(())
  }
}
