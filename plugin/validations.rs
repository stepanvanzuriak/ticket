
use crate::types::{pascal, snake};
use polar_plugin::{
  Diagnostic, Entry, Expansion, Module, Source, Span, Token, Zone, ZonePlugin, align,
};

pub struct Validations;

const NEEDS: [&[&str]; 4] =
  [&["Std", "Result"], &["Ticket", "Errors"], &["Ticket", "Validations"], &["Schema"]];

const UNIQUE_NEEDS: [&[&str]; 3] = [&["Std", "List"], &["Ticket", "Db"], &["Ticket", "Query"]];

const RULES: [&str; 5] = ["presence", "length", "format", "inclusion", "uniqueness"];

const RULES_HELP: &str = "the rules are `presence`, `length`, `format`, `inclusion` and `uniqueness`";

const LENGTH_HELP: &str = "a length is `3..120`, `3..` or `..120`";

enum Rule {
  Presence,
  Length(Option<String>, Option<String>),
  Inclusion(Vec<String>),
  Format(String),
  Uniqueness,
}

struct Check {
  field: String,
  field_span: Span,
  rule: Rule,
  span: Span,
}

impl ZonePlugin for Validations {
  fn zone(&self) -> Zone {
    Zone { keyword: "validations".to_string(), after: "binds".to_string(), blank_between_entries: false }
  }

  fn expand(&self, zone: Span, entries: &[Entry], module: &Module) -> Expansion {
    let mut out = Expansion::default();
    let mut checks = Vec::new();

    for entry in entries {
      for line in entry.lines() {
        parse_line(entry, &line, &mut checks, &mut out);
      }
    }

    let unique = checks.iter().any(|c| matches!(c.rule, Rule::Uniqueness));
    let needs = NEEDS.iter().chain(if unique { UNIQUE_NEEDS.iter() } else { [].iter() });

    for path in needs {
      if module.import(path).is_none() {
        let name = path.join(".");

        out.error(
          Diagnostic::error(format!("the `validations` zone needs `{name}`"), zone)
            .with_help(format!("add `{name}` to the `uses` zone")),
        );
      }
    }

    let Some(record) = module.name.clone() else {
      out.error(Diagnostic::error("the `validations` zone needs a module name", zone));
      return out;
    };

    if out.has_errors() {
      return out;
    }

    let names = Names::new(module, &record, unique);

    out.emit(function(&checks, &names, false, zone));
    out.emit(function(&checks, &names, true, zone));

    let mut exports = Source::new();

    exports.push("validate\nvalidate_update");
    out.emit(exports.finish("exports", zone));
    out
  }

  fn print(&self, entries: &[Entry]) -> Vec<Vec<String>> {
    let rows: Vec<Vec<String>> = entries.iter().map(row).collect();
    let aligned = align(&rows);

    entries
      .iter()
      .zip(aligned)
      .map(|(entry, text)| {
        let mut lines = vec![text];

        lines.extend(entry.comments.iter().map(|c| c.text.clone()));
        lines
      })
      .collect()
  }
}

fn row(entry: &Entry) -> Vec<String> {
  let tokens: Vec<&Token> = entry.tokens.iter().collect();

  match tokens.split_first() {
    Some((field, rest)) if !rest.is_empty() => vec![field.text.clone(), spaced(rest)],
    _ => vec![spaced(&tokens)],
  }
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

fn parse_line(entry: &Entry, line: &[&Token], checks: &mut Vec<Check>, out: &mut Expansion) {
  let field = line[0];

  if !field.is("Lower") {
    out.error(
      Diagnostic::error("a validation starts with a field name", field.span)
        .with_help("write `title  presence  length 3..120`"),
    );
    return;
  }

  if line.len() == 1 {
    out.error(Diagnostic::error(format!("`{}` has no rules", field.text), field.span).with_help(RULES_HELP));
    return;
  }

  let mut at = 1;

  while at < line.len() {
    let rule = line[at];

    at += 1;

    let parsed = match (rule.is("Lower"), rule.text.as_str()) {
      (true, "presence") => Some(Rule::Presence),
      (true, "uniqueness") => Some(Rule::Uniqueness),
      (true, "length") => length(line, &mut at, rule, out),
      (true, "inclusion") => inclusion(entry, line, &mut at, rule, out),
      (true, "format") => format(entry, line, &mut at, rule, out),
      _ => {
        out.error(Diagnostic::error(format!("`{}` is not a validation rule", rule.text), rule.span).with_help(RULES_HELP));
        None
      }
    };

    if let Some(rule_kind) = parsed {
      checks.push(Check { field: field.text.clone(), field_span: field.span, rule: rule_kind, span: rule.span });
    } else {
      while at < line.len() && !(line[at].is("Lower") && RULES.contains(&line[at].text.as_str())) {
        at += 1;
      }
    }
  }
}

fn length(line: &[&Token], at: &mut usize, rule: &Token, out: &mut Expansion) -> Option<Rule> {
  let bad = |out: &mut Expansion, span: Span| {
    out.error(Diagnostic::error("`length` takes a range", span).with_help(LENGTH_HELP));
  };
  let mut bound = |at: &mut usize| -> Option<String> {
    line.get(*at).filter(|t| t.is("Int")).map(|t| {
      *at += 1;
      t.text.clone()
    })
  };
  let min = bound(at);

  if !line.get(*at).is_some_and(|t| t.is("DotDot")) {
    bad(out, line.get(*at).map_or(rule.span, |t| t.span));
    return None;
  }

  *at += 1;

  let max = bound(at);

  if min.is_none() && max.is_none() {
    bad(out, rule.span);
    return None;
  }

  if let (Some(a), Some(b)) = (&min, &max)
    && a.parse::<i64>().unwrap_or(0) > b.parse::<i64>().unwrap_or(0)
  {
    out.error(Diagnostic::error(format!("the range `{a}..{b}` is empty"), rule.span));
    return None;
  }

  Some(Rule::Length(min, max))
}

fn format(entry: &Entry, line: &[&Token], at: &mut usize, rule: &Token, out: &mut Expansion) -> Option<Rule> {
  let bad = |out: &mut Expansion, span: Span| {
    out.error(
      Diagnostic::error("`format` takes a regular expression", span)
        .with_help("write `format \"^[a-z0-9-]+$\"`"),
    );
  };

  let Some(start) = line.get(*at).filter(|t| t.is("StringStart")) else {
    bad(out, line.get(*at).map_or(rule.span, |t| t.span));
    return None;
  };
  let Some(end) = line[*at..].iter().position(|t| t.is("StringEnd")).map(|n| *at + n) else {
    bad(out, start.span);
    return None;
  };

  if line[*at..=end].iter().any(|t| t.is("InterpStart")) {
    out.error(Diagnostic::error("`format` takes a plain pattern, not an interpolation", start.span));
    return None;
  }

  let pattern = entry.text(start.span.join(line[end].span)).to_string();

  *at = end + 1;
  Some(Rule::Format(pattern))
}

fn inclusion(entry: &Entry, line: &[&Token], at: &mut usize, rule: &Token, out: &mut Expansion) -> Option<Rule> {
  let mut values = Vec::new();

  while *at < line.len() {
    let token = line[*at];
    let end = match token.kind.as_str() {
      "StringStart" => line[*at..].iter().position(|t| t.is("StringEnd")).map(|n| *at + n),
      "Int" | "Float" | "Bool" => Some(*at),
      "Minus" if line.get(*at + 1).is_some_and(|t| t.is("Int") || t.is("Float")) => Some(*at + 1),
      _ => None,
    };

    let Some(end) = end else { break };

    if line[*at..=end].iter().any(|t| t.is("InterpStart")) {
      out.error(Diagnostic::error("`inclusion` takes plain values, not interpolations", token.span));
      return None;
    }

    values.push(entry.text(token.span.join(line[end].span)).to_string());
    *at = end + 1;
  }

  if values.is_empty() {
    out.error(
      Diagnostic::error("`inclusion` needs the values it allows", rule.span)
        .with_help("write `inclusion \"draft\" \"live\"`"),
    );
    return None;
  }

  Some(Rule::Inclusion(values))
}

struct Names {
  record: String,
  effect: String,
  prefix: String,
  schema: String,
  errors: String,
  validations: String,
  query: String,
  unique: bool,
}

impl Names {
  fn new(module: &Module, record: &str, unique: bool) -> Self {
    let local = |path: &[&str]| module.import(path).map(|i| i.local().to_string()).unwrap_or_default();
    let plural = record.strip_suffix('y').map_or_else(|| format!("{record}s"), |stem| format!("{stem}ies"));

    Names {
      record: record.to_string(),
      effect: pascal(&snake(&plural)),
      prefix: snake(record),
      schema: local(&["Schema"]),
      errors: local(&["Ticket", "Errors"]),
      validations: local(&["Ticket", "Validations"]),
      query: if unique { local(&["Ticket", "Query"]) } else { String::new() },
      unique,
    }
  }
}

fn function(checks: &[Check], names: &Names, update: bool, zone: Span) -> polar_plugin::Generated {
  let Names { record, effect, errors, .. } = names;
  let (name, row) = if update { ("validate_update", record.clone()) } else { ("validate", format!("New{record}")) };
  let effects =
    if names.unique { format!(" / {{{effect}, Throws<DbFailure>}}") } else { String::new() };
  let mut source = Source::new();

  source.from(zone, &format!("{name}(row: {row}) -> Result<{errors}, {row}>{effects} {{\n"));
  source.push(&format!("  let e0 = {errors}.empty()\n"));

  for (i, check) in checks.iter().enumerate() {
    source.push(&format!("  let e{} = ", i + 1));
    check_call(&mut source, check, i, names, update);
    source.push("\n");
  }

  source.push(&format!(
    "\n  if {errors}.is_empty(e{}) {{\n    Ok(row)\n  }} else {{\n    Err(e{})\n  }}\n}}",
    checks.len(),
    checks.len()
  ));
  source.finish("functions", zone)
}

fn check_call(source: &mut Source, check: &Check, i: usize, names: &Names, update: bool) {
  let (v, e) = (&names.validations, i);
  let field = &check.field;
  let prev = format!("e{e}");
  let open = |source: &mut Source, helper: &str| {
    source.from(check.span, &format!("{v}.{helper}({prev}, \"{field}\", "));
  };

  match &check.rule {
    Rule::Presence => {
      open(source, "presence");
      source.from(check.field_span, &format!("row.{field}"));
      source.from(check.span, ")");
    }
    Rule::Length(min, max) => {
      let (helper, bounds) = match (min, max) {
        (Some(a), Some(b)) => ("length_between", format!(", {a}, {b})")),
        (Some(a), None) => ("length_at_least", format!(", {a})")),
        (None, Some(b)) => ("length_at_most", format!(", {b})")),
        (None, None) => unreachable!("a range has a bound"),
      };

      open(source, helper);
      source.from(check.field_span, &format!("row.{field}"));
      source.from(check.span, &bounds);
    }
    Rule::Inclusion(values) => {
      open(source, "inclusion");
      source.from(check.field_span, &format!("row.{field}"));
      source.from(check.span, &format!(", [{}])", values.join(", ")));
    }
    Rule::Format(pattern) => {
      open(source, "format");
      source.from(check.field_span, &format!("row.{field}"));
      source.from(check.span, &format!(", {pattern})"));
    }
    Rule::Uniqueness => {
      let Names { effect, query, schema, prefix, .. } = names;
      let mut filters = format!("{query}.eq({schema}.{prefix}_{field}, row.{field})");

      if update {
        filters.push_str(&format!(", {query}.not_eq({schema}.{prefix}_id, row.id)"));
      }

      open(source, "uniqueness");
      source.from(check.span, &format!("{effect}.count([{filters}]))"));
    }
  }
}
