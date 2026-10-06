
use crate::types::{self, Type, pascal, singular, snake};
use std::collections::HashMap;
use polar_plugin::{
  Diagnostic, Entry, Expansion, Generated, Module, Source, Span, Token, Zone, ZonePlugin, align,
};

pub struct Migrations;

const NEEDS: [&[&str]; 10] = [
  &["Std", "Id"],
  &["Std", "Json"],
  &["Std", "List"],
  &["Std", "Option"],
  &["Std", "Result"],
  &["Ticket", "Db"],
  &["Ticket", "Form"],
  &["Ticket", "Migration"],
  &["Ticket", "Model"],
  &["Ticket", "Query"],
];

const OPS: [&str; 7] = [
  "create_table",
  "drop_table",
  "add_column",
  "remove_column",
  "rename_column",
  "add_index",
  "remove_index",
];

const COLUMN_HELP: &str =
  "a column is `name  Type  modifiers…`, like `title  String  default \"\"  unique`";

const TYPES_HELP: &str =
  "the column types are `Int`, `Float`, `String`, `Bool` and `Id<Record>` (with `references`), or `Option<…>` of one";

const TIMESTAMPS: [&str; 2] = ["created_at", "updated_at"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
  Int,
  Float,
  Text,
  Bool,
  Time,
  Now,
}

impl Kind {
  fn constructor(self) -> &'static str {
    match self {
      Kind::Int => "IntColumn",
      Kind::Float => "FloatColumn",
      Kind::Text => "TextColumn",
      Kind::Bool => "BoolColumn",
      Kind::Time => "TimeColumn",
      Kind::Now => "NowColumn",
    }
  }

  fn zero(self) -> &'static str {
    match self {
      Kind::Int => "SqlInt(0)",
      Kind::Float => "SqlFloat(0.0)",
      Kind::Text => "SqlText(\"\")",
      Kind::Bool => "SqlBool(false)",
      Kind::Time | Kind::Now => "SqlText(\"1970-01-01T00:00:00.000Z\")",
    }
  }
}

#[derive(Clone)]
struct Column {
  name: String,
  ty: String,
  kind: Kind,
  nullable: bool,
  default: Option<String>,
  references: Option<String>,
  on_delete: Option<String>,
  unique: bool,
  span: Span,
}

impl Column {
  fn has_default(&self) -> bool {
    self.default.is_some() || self.kind == Kind::Now
  }

  fn written(&self) -> bool {
    self.kind != Kind::Now
  }

  fn polar(&self, default: Option<&str>) -> String {
    let option = |value: Option<&str>| value.map_or_else(|| "None".to_string(), |v| format!("Some({v})"));
    let references = self.references.as_ref().map(|t| format!("\"{t}\""));
    let on_delete = self.on_delete.as_ref().map(|a| format!("\"{a}\""));

    format!(
      "{{ name: \"{}\", kind: {}, nullable: {}, default: {}, references: {}, on_delete: {} }}",
      self.name,
      self.kind.constructor(),
      self.nullable,
      option(default.or(self.default.as_deref())),
      option(references.as_deref()),
      option(on_delete.as_deref()),
    )
  }
}

#[derive(Clone, PartialEq, Eq)]
struct Index {
  name: String,
  table: String,
  columns: Vec<String>,
  unique: bool,
}

impl Index {
  fn new(table: &str, columns: Vec<String>, unique: bool) -> Self {
    Index { name: format!("index_{table}_on_{}", columns.join("_and_")), table: table.to_string(), columns, unique }
  }

  fn polar(&self) -> String {
    let columns: Vec<String> = self.columns.iter().map(|c| format!("\"{c}\"")).collect();

    format!(
      "{{ name: \"{}\", table: \"{}\", columns: [{}], unique: {} }}",
      self.name,
      self.table,
      columns.join(", "),
      self.unique,
    )
  }
}

#[derive(Clone)]
struct Table {
  name: String,
  record: String,
  columns: Vec<Column>,
  indexes: Vec<Index>,
  created: Span,
}

type Change = String;

struct Migration {
  version: String,
  name: String,
  up: Vec<Change>,
  down: Vec<Vec<Change>>,
}

struct Line<'a> {
  tokens: Vec<&'a Token>,
  children: Vec<Line<'a>>,
}

impl Line<'_> {
  fn span(&self) -> Span {
    self.tokens[0].span.join(self.tokens[self.tokens.len() - 1].span)
  }
}

struct Replay {
  tables: Vec<Table>,
  migrations: Vec<Migration>,
  last: Option<(String, Span)>,
  time: bool,
  out: Expansion,
}

impl ZonePlugin for Migrations {
  fn zone(&self) -> Zone {
    Zone { keyword: "migrations".to_string(), after: "traits".to_string(), blank_between_entries: true }
  }

  fn expand(&self, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
    let mut replay = Replay {
      tables: Vec::new(),
      migrations: Vec::new(),
      last: None,
      time: module.import(&["Std", "Time"]).is_some(),
      out: Expansion::default(),
    };

    for path in NEEDS {
      if module.import(path).is_none() {
        let name = path.join(".");

        replay.out.error(
          Diagnostic::error(format!("the `migrations` zone needs `{name}`"), zone)
            .with_help(format!("add `{name}` to the `uses` zone")),
        );
      }
    }

    if replay.out.has_errors() {
      return replay.out;
    }

    for entry in entries {
      for line in nest(entry.lines()) {
        replay.migration(&line);
      }
    }

    if replay.out.has_errors() {
      return replay.out;
    }

    let id = local(module, &["Std", "Id"]);
    let query = local(module, &["Ticket", "Query"]);
    let model = local(module, &["Ticket", "Model"]);
    let form = local(module, &["Ticket", "Form"]);
    let mut out = replay.out;
    let mut exports = vec!["migrations".to_string()];

    if let Some(clash) = clash(&replay.tables) {
      out.error(clash);
      return out;
    }

    for table in &replay.tables {
      out.emit(records(table, &id));
      out.emit(columns(table, &id, &query));
      out.emit(effect(table));
      out.emit(binds(table, &query, &model));
      out.emit(form_impl(table, &form));
      exports.push(pascal(&table.name));
      exports.extend(table.constants().into_iter().map(|(name, _, _)| name));
    }

    for assoc in associations(&replay.tables) {
      out.emit(association(&assoc, &query));
      exports.extend(assoc.names());
    }

    out.emit(constant(&replay.migrations, zone));

    let mut source = Source::new();

    source.push(&exports.join("\n"));
    out.emit(source.finish("exports", zone));
    out
  }

  fn print(&self, entries: &[Entry]) -> Vec<Vec<String>> {
    entries.iter().map(print).collect()
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

fn name(token: Option<&&Token>) -> Option<String> {
  let token = token?;
  let mut chars = token.text.chars();

  (token.is("Lower")
    && chars.next().is_some_and(|c| c.is_ascii_lowercase())
    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
  .then(|| token.text.clone())
}

fn version(text: &str) -> bool {
  let bytes = text.as_bytes();

  bytes.len() == 15
    && bytes[8] == b'_'
    && bytes.iter().enumerate().all(|(i, b)| i == 8 || b.is_ascii_digit())
}

impl Replay {
  fn error(&mut self, span: Span, message: impl Into<String>, help: Option<&str>) {
    let mut diagnostic = Diagnostic::error(message, span);

    if let Some(help) = help {
      diagnostic = diagnostic.with_help(help);
    }

    self.out.error(diagnostic);
  }

  fn table(&self, name: &str) -> Option<usize> {
    self.tables.iter().position(|t| t.name == name)
  }

  fn existing(&mut self, token: &Token) -> Option<usize> {
    let found = self.table(&token.text);

    if found.is_none() {
      let names: Vec<&str> = self.tables.iter().map(|t| t.name.as_str()).collect();
      let help = if names.is_empty() {
        format!("create it with `create_table {}` in an earlier migration", token.text)
      } else {
        format!("the tables at this point are: {}", names.join(", "))
      };

      self.error(token.span, format!("there's no table `{}` at this point", token.text), Some(&help));
    }

    found
  }

  fn migration(&mut self, line: &Line) {
    let tokens = &line.tokens;
    let header = "a migration starts `<version> <change> <table>`, like `20261001_120000 create_table posts`";

    let Some(first) = tokens.first().filter(|t| t.is("Int") && version(&t.text)) else {
      self.error(tokens[0].span, "a migration starts with its version, `YYYYMMDD_HHMMSS`", Some(header));
      return;
    };

    if let Some((last, span)) = self.last.clone()
      && first.text <= last
    {
      self.out.error(
        Diagnostic::error(format!("migration `{}` comes after `{last}`", first.text), first.span)
          .with_label("versions must increase")
          .with_secondary(span, "the migration before it"),
      );
      return;
    }

    self.last = Some((first.text.clone(), first.span));

    let op = tokens.get(1).filter(|t| OPS.contains(&t.text.as_str()));
    let Some(op) = op else {
      let span = tokens.get(1).map_or(first.span, |t| t.span);
      let help = format!("the changes are: {}", OPS.join(", "));

      self.error(span, "expected a change after the version", Some(&help));
      return;
    };

    let Some(table) = tokens.get(2).filter(|t| name(Some(t)).is_some()) else {
      let span = tokens.get(2).map_or(op.span, |t| t.span);

      self.error(span, format!("`{}` needs a snake_case table name", op.text), Some(header));
      return;
    };

    let rest = &tokens[3..];

    if op.text != "create_table" && !rest.is_empty() {
      let span = rest[0].span.join(rest[rest.len() - 1].span);

      self.error(span, format!("unexpected `{}` after the table name", rest[0].text), None);
      return;
    }

    for child in &line.children {
      if let Some(grandchild) = child.children.first() {
        self.error(grandchild.span(), "this line is indented too far", None);
        return;
      }
    }

    let errors = self.out.diagnostics.len();
    let mut migration = Migration {
      version: first.text.clone(),
      name: format!("{} {}", op.text, table.text),
      up: Vec::new(),
      down: Vec::new(),
    };

    match op.text.as_str() {
      "create_table" => self.create_table(line, table, rest, &mut migration),
      "drop_table" => self.drop_table(line, table, &mut migration),
      "add_column" => self.add_column(line, table, &mut migration),
      "remove_column" => self.remove_column(line, table, &mut migration),
      "rename_column" => self.rename_column(line, table, &mut migration),
      "add_index" | "remove_index" => self.index(line, table, op.text == "add_index", &mut migration),
      _ => unreachable!(),
    }

    if self.out.diagnostics.len() == errors {
      self.migrations.push(migration);
    }
  }

  fn needs_children(&mut self, line: &Line, what: &str) -> bool {
    if line.children.is_empty() {
      self.error(line.span(), format!("`{}` needs {what} on the lines under it", line.tokens[1].text), None);
      return false;
    }

    true
  }

  fn create_table(&mut self, line: &Line, table: &Token, rest: &[&Token], migration: &mut Migration) {
    if let Some(at) = self.table(&table.text) {
      let created = self.tables[at].created;

      self.out.error(
        Diagnostic::error(format!("table `{}` already exists", table.text), table.span)
          .with_secondary(created, "created here"),
      );
      return;
    }

    let record = match rest {
      [] => match singular(&table.text) {
        Some(word) => pascal(&word),
        None => {
          let help = format!("name its record with `as`, like `create_table {} as Person`", table.text);

          self.error(table.span, format!("can't tell the singular of `{}`", table.text), Some(&help));
          return;
        }
      },
      [kw, record] if kw.is("KwAs") && record.is("Upper") => record.text.clone(),
      _ => {
        let span = rest[0].span.join(rest[rest.len() - 1].span);

        self.error(span, "expected `as Record` after the table name", None);
        return;
      }
    };

    if let Some(other) = self.tables.iter().find(|t| t.record == record || format!("New{}", t.record) == record) {
      let message = format!("record `{record}` is already table `{}`'s", other.name);
      let created = other.created;

      self.out.error(
        Diagnostic::error(message, line.span())
          .with_secondary(created, "that table")
          .with_help("name this one's record with `as`"),
      );
      return;
    }

    if !self.needs_children(line, "its columns") {
      return;
    }

    let mut created = Table {
      name: table.text.clone(),
      record,
      columns: Vec::new(),
      indexes: Vec::new(),
      created: line.span(),
    };

    self.tables.push(created.clone());

    let at = self.tables.len() - 1;

    for child in &line.children {
      let columns = if is_timestamps(child) {
        self.timestamps(child, &self.tables[at].clone())
      } else {
        self.column(child, &self.tables[at].clone()).into_iter().collect()
      };

      for column in columns {
        created.columns.push(column.clone());
        self.tables[at].columns.push(column);
      }
    }

    created.indexes = unique_indexes(&created.name, &created.columns);

    let columns: Vec<String> = created.columns.iter().map(|c| c.polar(None)).collect();

    migration.up.push(format!("CreateTable(\"{}\", [{}])", created.name, columns.join(", ")));
    migration.down.push(vec![format!("DropTable(\"{}\")", created.name)]);

    for index in &created.indexes {
      migration.up.push(format!("AddIndex({})", index.polar()));
      migration.down.push(vec![format!("RemoveIndex({})", index.polar())]);
    }

    self.tables[at] = created;
  }

  fn drop_table(&mut self, line: &Line, table: &Token, migration: &mut Migration) {
    let Some(at) = self.existing(table) else { return };

    if let Some(child) = line.children.first() {
      self.error(child.span(), "`drop_table` takes nothing under it", None);
      return;
    }

    let dropped = &self.tables[at];

    for other in self.tables.iter().filter(|t| t.name != dropped.name) {
      if let Some(column) = other.columns.iter().find(|c| c.references.as_deref() == Some(&dropped.name)) {
        let message = format!("can't drop `{}`: `{}.{}` references it", dropped.name, other.name, column.name);
        let help = format!("remove `{}.{}` first", other.name, column.name);

        self.out.error(
          Diagnostic::error(message, line.span())
            .with_secondary(column.span, "the reference")
            .with_help(help),
        );
        return;
      }
    }

    let columns: Vec<String> = dropped.columns.iter().map(|c| c.polar(None)).collect();
    let mut down = vec![format!("CreateTable(\"{}\", [{}])", dropped.name, columns.join(", "))];

    down.extend(dropped.indexes.iter().map(|i| format!("AddIndex({})", i.polar())));
    migration.up.push(format!("DropTable(\"{}\")", dropped.name));
    migration.down.push(down);
    self.tables.remove(at);
  }

  fn add_column(&mut self, line: &Line, table: &Token, migration: &mut Migration) {
    let Some(at) = self.existing(table) else { return };

    if !self.needs_children(line, "its columns") {
      return;
    }

    for child in &line.children {
      if is_timestamps(child) {
        self.error(
          child.span(),
          "`timestamps` can only be in `create_table`: SQLite can't add a column that defaults to the current time",
          Some("add `created_at  Time` and `updated_at  Time` with a `default`, or leave them out"),
        );
        continue;
      }

      let Some(column) = self.column(child, &self.tables[at].clone()) else { continue };

      if !column.nullable && column.references.is_some() {
        let help = format!("make it `Option<{}>`", column.ty);

        self.error(child.span(), "SQLite can only add a `references` column that allows NULL", Some(&help));
        continue;
      }

      if !column.nullable && !column.has_default() {
        let help = format!("give it a default (`default …`), or make it `Option<{}>`", column.ty);

        self.error(child.span(), format!("an added column `{}` needs a default", column.name), Some(&help));
        continue;
      }

      let name = &self.tables[at].name;

      migration.up.push(format!("AddColumn(\"{name}\", {})", column.polar(None)));
      migration.down.push(vec![format!("RemoveColumn(\"{name}\", \"{}\")", column.name)]);

      if column.unique {
        let index = Index::new(name, vec![column.name.clone()], true);

        migration.up.push(format!("AddIndex({})", index.polar()));
        migration.down.push(vec![format!("RemoveIndex({})", index.polar())]);
        self.tables[at].indexes.push(index);
      }

      self.tables[at].columns.push(column);
    }
  }

  fn remove_column(&mut self, line: &Line, table: &Token, migration: &mut Migration) {
    let Some(at) = self.existing(table) else { return };

    if !self.needs_children(line, "the names of the columns") {
      return;
    }

    for child in &line.children {
      let Some(column) = self.single_name(child, at) else { continue };
      let current = self.tables[at].columns[column].clone();

      if current.references.is_some() {
        self.error(child.span(), format!("SQLite can't remove `{}`: it's a `references` column", current.name), None);
        continue;
      }

      let table = self.tables[at].name.clone();
      let (indexed, kept): (Vec<Index>, Vec<Index>) =
        self.tables[at].indexes.drain(..).partition(|i| i.columns.contains(&current.name));

      self.tables[at].indexes = kept;

      for index in &indexed {
        migration.up.push(format!("RemoveIndex({})", index.polar()));
        migration.down.push(vec![format!("AddIndex({})", index.polar())]);
      }

      let zero = (!current.nullable && current.default.is_none()).then(|| current.kind.zero());
      let current = Column { kind: if current.kind == Kind::Now { Kind::Time } else { current.kind }, ..current };

      migration.up.push(format!("RemoveColumn(\"{table}\", \"{}\")", current.name));
      migration.down.push(vec![format!("AddColumn(\"{table}\", {})", current.polar(zero))]);
      self.tables[at].columns.remove(column);
    }
  }

  fn rename_column(&mut self, line: &Line, table: &Token, migration: &mut Migration) {
    let Some(at) = self.existing(table) else { return };

    if !self.needs_children(line, "`old -> new` names") {
      return;
    }

    for child in &line.children {
      let help = "write `old_name -> new_name`";
      let (Some(from), Some(arrow), Some(to), None) =
        (name(child.tokens.first()), child.tokens.get(1), name(child.tokens.get(2)), child.tokens.get(3))
      else {
        self.error(child.span(), "expected `old_name -> new_name`", Some(help));
        continue;
      };

      if !arrow.is("Arrow") {
        self.error(arrow.span, "expected `->`", Some(help));
        continue;
      }

      let Some(column) = self.find_column(at, &from, child.tokens[0].span) else { continue };

      if to == "id" || self.tables[at].columns.iter().any(|c| c.name == to) {
        self.error(child.tokens[2].span, format!("`{}` already has a column `{to}`", self.tables[at].name.clone()), None);
        continue;
      }

      let table = self.tables[at].name.clone();

      migration.up.push(format!("RenameColumn(\"{table}\", \"{from}\", \"{to}\")"));
      migration.down.push(vec![format!("RenameColumn(\"{table}\", \"{to}\", \"{from}\")")]);
      self.tables[at].columns[column].name = to.clone();

      for index in &mut self.tables[at].indexes {
        for c in &mut index.columns {
          if *c == from {
            c.clone_from(&to);
          }
        }
      }
    }
  }

  fn index(&mut self, line: &Line, table: &Token, add: bool, migration: &mut Migration) {
    let Some(at) = self.existing(table) else { return };

    if !self.needs_children(line, "an index's columns on each line") {
      return;
    }

    for child in &line.children {
      let mut tokens: &[&Token] = &child.tokens;
      let unique = tokens.len() > 1 && tokens[tokens.len() - 1].text == "unique";

      if unique {
        tokens = &tokens[..tokens.len() - 1];
      }

      let mut columns = Vec::new();

      for token in tokens {
        match name(Some(token)) {
          Some(column) if column == "id" || self.tables[at].columns.iter().any(|c| c.name == column) => {
            columns.push(column);
          }
          Some(column) => {
            let table = self.tables[at].name.clone();

            self.error(token.span, format!("`{table}` has no column `{column}`"), None);
          }
          None => self.error(token.span, "expected a column name", Some("an index line is `column…` with an optional `unique`")),
        }
      }

      if columns.len() != tokens.len() {
        continue;
      }

      let table = self.tables[at].name.clone();
      let wanted = Index::new(&table, columns, unique);
      let existing = self.tables[at].indexes.iter().position(|i| i.name == wanted.name);

      match (add, existing) {
        (true, None) => {
          migration.up.push(format!("AddIndex({})", wanted.polar()));
          migration.down.push(vec![format!("RemoveIndex({})", wanted.polar())]);
          self.tables[at].indexes.push(wanted);
        }
        (true, Some(_)) => self.error(child.span(), format!("`{table}` already has the index `{}`", wanted.name), None),
        (false, Some(i)) => {
          let index = self.tables[at].indexes.remove(i);

          migration.up.push(format!("RemoveIndex({})", index.polar()));
          migration.down.push(vec![format!("AddIndex({})", index.polar())]);
        }
        (false, None) => self.error(child.span(), format!("`{table}` has no index `{}`", wanted.name), None),
      }
    }
  }

  fn single_name(&mut self, line: &Line, at: usize) -> Option<usize> {
    match (name(line.tokens.first()), line.tokens.get(1)) {
      (Some(column), None) => self.find_column(at, &column, line.tokens[0].span),
      _ => {
        self.error(line.span(), "expected one column name on this line", None);
        None
      }
    }
  }

  fn find_column(&mut self, at: usize, column: &str, span: Span) -> Option<usize> {
    let table = self.tables[at].name.clone();

    if column == "id" {
      self.error(span, "`id` is the primary key, and can't change", None);
      return None;
    }

    let found = self.tables[at].columns.iter().position(|c| c.name == column);

    if found.is_none() {
      self.error(span, format!("`{table}` has no column `{column}`"), None);
    }

    found
  }

  fn timestamps(&mut self, line: &Line, table: &Table) -> Vec<Column> {
    let span = line.span();

    if !self.time {
      self.error(span, "`timestamps` needs `Std.Time`", Some("add `Std.Time` to the `uses` zone"));
      return Vec::new();
    }

    if let Some(name) = TIMESTAMPS.iter().find(|n| table.columns.iter().any(|c| &c.name == *n)) {
      self.error(span, format!("`{}` already has a column `{name}`", table.name), None);
      return Vec::new();
    }

    TIMESTAMPS
      .iter()
      .map(|name| Column {
        name: name.to_string(),
        ty: "Time".to_string(),
        kind: Kind::Now,
        nullable: false,
        default: None,
        references: None,
        on_delete: None,
        unique: false,
        span,
      })
      .collect()
  }

  fn column(&mut self, line: &Line, table: &Table) -> Option<Column> {
    let tokens = &line.tokens;

    let Some(column) = name(tokens.first()) else {
      self.error(tokens[0].span, "expected a snake_case column name", Some(COLUMN_HELP));
      return None;
    };

    if column == "id" {
      self.error(tokens[0].span, "every table already has `id`", Some("leave it out"));
      return None;
    }

    if table.columns.iter().any(|c| c.name == column) {
      self.error(tokens[0].span, format!("`{}` already has a column `{column}`", table.name), None);
      return None;
    }

    let mut at = 1;
    let Some(ty) = types::parse(tokens, &mut at) else {
      let span = tokens.get(1).map_or(tokens[0].span, |t| t.span);

      self.error(span, format!("expected a type for `{column}`"), Some(TYPES_HELP));
      return None;
    };

    let (base, nullable) = match ty.arg_of("Option") {
      Some(inner) => (inner.clone(), true),
      None => (ty.clone(), false),
    };
    let kind = self.kind(&base)?;
    let mut parsed = Column {
      name: column,
      ty: ty.text(),
      kind,
      nullable,
      default: None,
      references: None,
      on_delete: None,
      unique: false,
      span: line.span(),
    };

    while at < tokens.len() {
      let modifier = tokens[at];

      at += 1;

      match modifier.text.as_str() {
        "unique" => parsed.unique = true,
        "default" if parsed.default.is_none() => parsed.default = Some(self.default(tokens, &mut at, &base, modifier)?),
        "references" if parsed.references.is_none() => {
          let Some(target) = name(tokens.get(at)) else {
            self.error(modifier.span, "`references` needs a table name", None);
            return None;
          };

          at += 1;
          parsed.references = Some(self.reference(&base, &target, tokens[at - 1].span, table)?);
        }
        "on_delete" if parsed.on_delete.is_none() => {
          parsed.on_delete = Some(self.on_delete(tokens, &mut at, &parsed, modifier)?);
        }
        "default" | "references" | "on_delete" => {
          self.error(modifier.span, format!("`{}` is given twice", modifier.text), None);
          return None;
        }
        _ => {
          self.error(
            modifier.span,
            format!("unexpected `{}` in a column", modifier.text),
            Some("the modifiers are `default <value>`, `references <table>`, `on_delete <action>` and `unique`"),
          );
          return None;
        }
      }
    }

    if base.arg_of("Id").is_some() && parsed.references.is_none() {
      let help = format!("add `references <table>` for the table whose id `{}` holds", parsed.name);

      self.error(ty.span, "an `Id` column needs `references`", Some(&help));
      return None;
    }

    Some(parsed)
  }

  fn kind(&mut self, base: &Type) -> Option<Kind> {
    if base.is("Int") || base.arg_of("Id").is_some() {
      Some(Kind::Int)
    } else if base.is("Float") {
      Some(Kind::Float)
    } else if base.is("String") {
      Some(Kind::Text)
    } else if base.is("Bool") {
      Some(Kind::Bool)
    } else if base.is("Time") {
      if !self.time {
        self.error(base.span, "`Time` columns need `Std.Time`", Some("add `Std.Time` to the `uses` zone"));
        return None;
      }

      Some(Kind::Time)
    } else {
      self.error(base.span, format!("`{}` can't be a column type", base.text()), Some(TYPES_HELP));
      None
    }
  }

  fn reference(&mut self, base: &Type, target: &str, span: Span, table: &Table) -> Option<String> {
    let record = if target == table.name {
      Some(table.record.clone())
    } else {
      self.table(target).map(|t| self.tables[t].record.clone())
    };

    let Some(record) = record else {
      self.error(span, format!("there's no table `{target}` at this point"), None);
      return None;
    };

    let wanted = format!("Id<{record}>");

    if base.text() != wanted {
      let help = format!("make it `{wanted}`, or `Option<{wanted}>`");

      self.error(base.span, format!("a column that references `{target}` holds an `{wanted}`"), Some(&help));
      return None;
    }

    Some(target.to_string())
  }

  fn on_delete(&mut self, tokens: &[&Token], at: &mut usize, column: &Column, modifier: &Token) -> Option<String> {
    let help = "`on_delete` is `cascade` (delete the rows too), `set_null` (an `Option` column) or `restrict`";

    if column.references.is_none() {
      self.error(modifier.span, "`on_delete` needs `references` before it", Some("write `references users  on_delete cascade`"));
      return None;
    }

    let Some(action) = tokens.get(*at) else {
      self.error(modifier.span, "`on_delete` needs an action", Some(help));
      return None;
    };

    *at += 1;

    match action.text.as_str() {
      "cascade" => Some("CASCADE".to_string()),
      "restrict" => Some("RESTRICT".to_string()),
      "set_null" if column.nullable => Some("SET NULL".to_string()),
      "set_null" => {
        self.error(action.span, format!("`set_null` needs `{}` to allow NULL", column.name), Some("make it `Option<Id<…>>`"));
        None
      }
      other => {
        self.error(action.span, format!("`{other}` isn't an `on_delete` action"), Some(help));
        None
      }
    }
  }

  fn default(&mut self, tokens: &[&Token], at: &mut usize, base: &Type, modifier: &Token) -> Option<String> {
    let help = "a default is a literal: `0`, `-1`, `1.5`, `\"text\"`, `true` or `false`";
    let Some(first) = tokens.get(*at) else {
      self.error(modifier.span, "`default` needs a value", Some(help));
      return None;
    };
    let negative = first.is("Minus") && tokens.get(*at + 1).is_some_and(|t| t.span.start == first.span.end);
    let value = if negative { tokens[*at + 1] } else { first };
    let sign = if negative { "-" } else { "" };
    let literal = match value.kind.as_str() {
      "Int" if base.is("Int") => Some(format!("SqlInt({sign}{})", value.text)),
      "Int" if base.is("Float") => Some(format!("SqlFloat({sign}{}.0)", value.text)),
      "Float" if base.is("Float") => Some(format!("SqlFloat({sign}{})", value.text)),
      "KwTrue" | "KwFalse" if base.is("Bool") && !negative => Some(format!("SqlBool({})", value.text)),
      "StringStart" if base.is("String") && !negative => {
        let end = tokens[*at..].iter().position(|t| t.is("StringEnd")).map(|i| *at + i);
        let interpolated = tokens[*at..].iter().take_while(|t| !t.is("StringEnd")).any(|t| t.is("InterpStart"));

        match end {
          Some(end) if !interpolated => {
            let text: String = tokens[*at..=end].iter().map(|t| t.text.as_str()).collect();

            *at = end;
            Some(format!("SqlText({text})"))
          }
          _ => None,
        }
      }
      _ => None,
    };

    let Some(literal) = literal else {
      let end = tokens[*at..].iter().position(|t| t.is("StringEnd")).filter(|_| value.is("StringStart"));
      let span = end.map_or(first.span.join(value.span), |i| first.span.join(tokens[*at + i].span));
      let text: String = tokens.iter().filter(|t| t.span.start >= span.start && t.span.end <= span.end).map(|t| t.text.as_str()).collect();

      self.error(span, format!("`{text}` isn't a default for a column of type `{}`", base.text()), Some(help));
      return None;
    };

    *at += if negative { 2 } else { 1 };
    Some(literal)
  }
}

impl Table {
  fn constants(&self) -> Vec<(String, String, Span)> {
    let prefix = snake(&self.record);
    let mut constants = vec![(format!("{prefix}_id"), format!("Id<{}>", self.record), self.created)];

    constants.extend(self.columns.iter().map(|c| (format!("{prefix}_{}", c.name), c.ty.clone(), c.span)));
    constants
  }
}

fn clash(tables: &[Table]) -> Option<Diagnostic> {
  let mut seen: HashMap<String, (String, Span)> = HashMap::new();

  for table in tables {
    for (name, _, span) in table.constants() {
      let here = format!("`{}`", table.name);

      if let Some((other, first)) = seen.get(&name) {
        return Some(
          Diagnostic::error(format!("the column constant `{name}` is already taken"), span)
            .with_label(format!("in {here}"))
            .with_secondary(*first, format!("by this one, in {other}"))
            .with_help("rename one of the columns: the constant is `<record>_<column>`"),
        );
      }

      seen.insert(name, (here, span));
    }
  }

  for assoc in associations(tables) {
    for name in assoc.names() {
      let here = format!("`{}.{}`", assoc.table, assoc.column);

      if let Some((other, first)) = seen.get(&name) {
        return Some(
          Diagnostic::error(format!("the association `{name}` is already taken"), assoc.span)
            .with_label(format!("from {here}"))
            .with_secondary(*first, format!("by this one, in {other}"))
            .with_help("rename a column: associations are named after the `references` column"),
        );
      }

      seen.insert(name, (here, assoc.span));
    }
  }

  None
}

struct Association {
  table: String,
  column: String,
  span: Span,
  record: String,
  target_record: String,
  target_table: String,
  nullable: bool,
  belongs_to: String,
  has_many: String,
}

impl Association {
  fn names(&self) -> Vec<String> {
    vec![self.belongs_to.clone(), self.has_many.clone(), format!("{}_filter", self.has_many)]
  }
}

fn associations(tables: &[Table]) -> Vec<Association> {
  let mut found = Vec::new();

  for table in tables {
    for column in &table.columns {
      let Some(target) = column.references.as_ref().and_then(|t| tables.iter().find(|x| &x.name == t)) else {
        continue;
      };
      let Some(stem) = column.name.strip_suffix("_id").filter(|s| !s.is_empty()) else { continue };
      let conventional = column.name == format!("{}_id", snake(&target.record));
      let inverse = format!("{}_{}", snake(&target.record), table.name);

      found.push(Association {
        table: table.name.clone(),
        column: column.name.clone(),
        span: column.span,
        record: table.record.clone(),
        target_record: target.record.clone(),
        target_table: target.name.clone(),
        nullable: column.nullable,
        belongs_to: format!("{}_{stem}", snake(&table.record)),
        has_many: if conventional { inverse } else { format!("{inverse}_as_{stem}") },
      });
    }
  }

  found
}

fn is_timestamps(line: &Line) -> bool {
  line.tokens.len() == 1 && line.tokens[0].text == "timestamps"
}

fn unique_indexes(table: &str, columns: &[Column]) -> Vec<Index> {
  columns.iter().filter(|c| c.unique).map(|c| Index::new(table, vec![c.name.clone()], true)).collect()
}

fn records(table: &Table, id: &str) -> Generated {
  let mut source = Source::new();
  let fields = |source: &mut Source| {
    for column in &table.columns {
      source.push(",\n  ");
      source.from(column.span, &format!("{}: {}", column.name, column.ty));
    }
  };

  source.from(table.created, &format!("{} = {{\n  id: {id}<{}>", table.record, table.record));
  fields(&mut source);
  source.push(",\n} derive(Json, Eq)\n\n");

  let written: Vec<&Column> = table.columns.iter().filter(|c| c.written()).collect();

  if written.is_empty() {
    source.from(table.created, &format!("New{} = {{}}", table.record));
  } else {
    source.from(table.created, &format!("New{} = {{\n  ", table.record));

    for (i, column) in written.iter().enumerate() {
      if i > 0 {
        source.push(",\n  ");
      }

      source.from(column.span, &format!("{}: {}", column.name, column.ty));
    }

    source.push(",\n} derive(Json, Eq)");
  }

  source.finish("types", table.created)
}

fn columns(table: &Table, id: &str, query: &str) -> Generated {
  let mut source = Source::new();

  for (i, (name, ty, span)) in table.constants().iter().enumerate() {
    let column = if i == 0 { "id" } else { table.columns[i - 1].name.as_str() };
    let ty = if i == 0 { format!("{id}<{}>", table.record) } else { ty.clone() };

    if i > 0 {
      source.push("\n");
    }

    source.from(
      *span,
      &format!("{name}: {}<{}, {ty}> = {query}.column(\"{}\", \"{column}\")", "Column", table.record, table.name),
    );
  }

  source.finish("constants", table.created)
}

fn effect(table: &Table) -> Generated {
  let (record, name) = (&table.record, pascal(&table.name));
  let mut source = Source::new();

  source.from(
    table.created,
    &format!(
      "{name} {{\n  \
       find(id: Id<{record}>) -> Option<{record}> / {{Throws<DbFailure>}}\n  \
       all() -> List<{record}> / {{Throws<DbFailure>}}\n  \
       filter(filters: List<Filter<{record}>>, clauses: List<Clause<{record}>>) -> List<{record}> / {{Throws<DbFailure>}}\n  \
       count(filters: List<Filter<{record}>>) -> Int / {{Throws<DbFailure>}}\n  \
       insert(row: New{record}) -> {record} / {{Throws<DbFailure>}}\n  \
       update(row: {record}) -> {record} / {{Throws<DbFailure>}}\n  \
       delete(id: Id<{record}>) -> Bool / {{Throws<DbFailure>}}\n}}"
    ),
  );
  source.finish("effects", table.created)
}

fn binds(table: &Table, query: &str, model: &str) -> Generated {
  let name = pascal(&table.name);
  let t = &table.name;
  let written: Vec<&Column> = table.columns.iter().filter(|c| c.written()).collect();
  let names: Vec<String> = written.iter().map(|c| format!("\"{}\"", c.name)).collect();
  let values: Vec<String> = written.iter().map(|c| format!("{query}.to_sql(row.{})", c.name)).collect();
  let touch = table.columns.iter().any(|c| c.name == "updated_at" && c.kind == Kind::Now);
  let (names, values) = (names.join(", "), values.join(", "));
  let mut source = Source::new();

  source.from(
    table.created,
    &format!(
      "{name} in Node {{\n  \
       find(id) {{\n    {model}.find(\"{t}\", id)\n  }}\n\n  \
       all() {{\n    {model}.all(\"{t}\")\n  }}\n\n  \
       filter(filters, clauses) {{\n    {model}.filter(\"{t}\", filters, clauses)\n  }}\n\n  \
       count(filters) {{\n    {model}.count(\"{t}\", filters)\n  }}\n\n  \
       insert(row) {{\n    {model}.insert(\"{t}\", [{names}], [{values}])\n  }}\n\n  \
       update(row) {{\n    {model}.update(\"{t}\", [{names}], [{values}], row.id, {touch})\n  }}\n\n  \
       delete(id) {{\n    {model}.delete(\"{t}\", id)\n  }}\n}}"
    ),
  );
  source.finish("binds", table.created)
}

fn association(a: &Association, query: &str) -> Generated {
  let (record, target) = (&a.record, &a.target_record);
  let (effect, target_effect) = (pascal(&a.table), pascal(&a.target_table));
  let (column, local) = (format!("{}_{}", snake(record), a.column), a.column.as_str());
  let id = format!("{}_id", snake(record));
  let owner = if a.nullable { "Some(row.id)" } else { "row.id" };
  let mut source = Source::new();

  if a.nullable {
    source.from(
      a.span,
      &format!(
        "{0}(row: {record}) -> Option<{target}> / {{{target_effect}, Throws<DbFailure>}} {{\n  \
         match row.{local} {{\n    None -> None,\n    Some(id) -> {target_effect}.find(id),\n  }}\n}}\n\n",
        a.belongs_to
      ),
    );
  } else {
    source.from(
      a.span,
      &format!(
        "{0}(row: {record}) -> {target} / {{{target_effect}, Throws<DbFailure>}} {{\n  \
         match {target_effect}.find(row.{local}) {{\n    Some(found) -> found,\n    \
         None -> throw DbFailure({{\n      kind: \"not_found\",\n      code: \"\",\n      \
         message: \"no {target} for {record}.{local}\",\n      sql: \"\",\n    }}),\n  }}\n}}\n\n",
        a.belongs_to
      ),
    );
  }

  source.from(
    a.span,
    &format!(
      "{0}(row: {target}) -> List<{record}> / {{{effect}, Throws<DbFailure>}} {{\n  \
       {effect}.filter([{query}.eq({column}, {owner})], [{query}.order_asc({id})])\n}}\n\n\
       {0}_filter(\n  row: {target},\n  filters: List<Filter<{record}>>,\n  clauses: List<Clause<{record}>>,\n) \
       -> List<{record}> / {{{effect}, Throws<DbFailure>}} {{\n  \
       {effect}.filter([{query}.eq({column}, {owner}), ..filters], clauses)\n}}",
      a.has_many
    ),
  );
  source.finish("functions", a.span)
}

fn form_impl(table: &Table, form: &str) -> Generated {
  let written: Vec<&Column> = table.columns.iter().filter(|c| c.written()).collect();
  let mut source = Source::new();

  source.from(table.created, &format!("{form} for New{} {{\n  from_form(fields) {{", table.record));

  for column in &written {
    let parse = match (&column.references, column.kind) {
      (Some(_), _) => "id",
      (None, Kind::Int) => "int",
      (None, Kind::Float) => "float",
      (None, Kind::Text) => "text",
      (None, Kind::Bool) => "bool",
      (None, Kind::Time | Kind::Now) => "time",
    };
    let read = if column.nullable { "optional" } else { "required" };

    source.push(&format!("\n    let {0} = {form}.{read}(fields, \"{0}\", {form}.{parse})", column.name));
  }

  let failures: Vec<String> =
    written.iter().map(|c| format!("{form}.failure(\"{0}\", {0})", c.name)).collect();
  let fields: Vec<String> = written.iter().map(|c| format!("{0}: {0}", c.name)).collect();

  source.push(&format!("\n    let errors = {form}.errors([{}])\n\n    ", failures.join(", ")));

  for column in &written {
    source.push(&format!("match {0} {{\n      Err(_) -> Err(errors),\n      Ok({0}) -> ", column.name));
  }

  source.push(&format!("Ok({{ {} }})", fields.join(", ")));

  for _ in &written {
    source.push(",\n    }");
  }

  source.push("\n  }\n}");
  source.finish("impls", table.created)
}

fn constant(migrations: &[Migration], zone: Span) -> Generated {
  let mut source = Source::new();

  source.push("migrations: List<Migration> = [");

  for migration in migrations {
    let down: Vec<&Change> = migration.down.iter().rev().flatten().collect();
    let list = |changes: Vec<&Change>| {
      changes.iter().map(|c| format!("\n      {c},")).collect::<String>()
    };

    source.push(&format!(
      "\n  {{\n    version: \"{}\",\n    name: \"{}\",\n    up: [{}\n    ],\n    down: [{}\n    ],\n  }},",
      migration.version,
      migration.name,
      list(migration.up.iter().collect()),
      list(down),
    ));
  }

  source.push("\n]");
  source.finish("constants", zone)
}

fn spaced(tokens: &[&Token]) -> String {
  let mut text = String::new();

  for (i, token) in tokens.iter().enumerate() {
    if i > 0 && tokens[i - 1].span.end != token.span.start {
      text.push(' ');
    }

    text.push_str(&token.text);
  }

  text
}

fn cells(tokens: &[&Token]) -> Vec<String> {
  let mut at = 1;

  if tokens.len() < 2 || types::parse(tokens, &mut at).is_none() {
    return vec![spaced(tokens)];
  }

  let mut row = vec![tokens[0].text.clone(), spaced(&tokens[1..at])];

  if at < tokens.len() {
    row.push(spaced(&tokens[at..]));
  }

  row
}

fn print(entry: &Entry) -> Vec<String> {
  let lines = entry.lines();
  let columns = lines.first().and_then(|l| l.get(1)).is_some_and(|t| t.text == "create_table" || t.text == "add_column");
  let mut rows: Vec<(usize, usize, Vec<String>)> = Vec::new();

  for (i, line) in lines.iter().enumerate() {
    let depth = usize::from(i > 0 && line[0].column > lines[0][0].column);
    let row = if i > 0 && columns { cells(line) } else { vec![spaced(line)] };

    rows.push((line[0].line, depth, row));
  }

  let aligned = align(&rows.iter().filter(|(_, depth, _)| *depth > 0).map(|(_, _, r)| r.clone()).collect::<Vec<_>>());
  let mut next = aligned.into_iter();
  let mut printed: Vec<(usize, String)> = rows
    .iter()
    .map(|(line, depth, row)| {
      let text = if *depth > 0 { next.next().unwrap_or_default() } else { row.join(" ") };

      (*line, format!("{}{text}", "  ".repeat(*depth)))
    })
    .collect();

  for comment in &entry.comments {
    match printed.iter_mut().find(|(line, _)| *line == comment.line) {
      Some((_, text)) => text.push_str(&format!("  {}", comment.text)),
      None => {
        let depth = usize::from(lines.first().is_some_and(|l| comment.column > l[0].column));

        printed.push((comment.line, format!("{}{}", "  ".repeat(depth), comment.text)));
      }
    }
  }

  printed.sort_by_key(|(line, _)| *line);
  printed.into_iter().map(|(_, text)| text).collect()
}
