#!/usr/bin/env python3
"""Export the literal ANSWER_RULES array from the original questionnaire userscript."""

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


DECLARATION = re.compile(r"^[^\S\n]*(?:const|let|var)\s+ANSWER_RULES\s*=", re.MULTILINE)
TRIVIA = re.compile(r"\s+|//[^\r\n]*|/\*[\s\S]*?\*/")
IDENTIFIER = re.compile(r"[$A-Za-z_][$A-Za-z_0-9]*")
REGEX = re.compile(r"/((?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/[\r\n\\])+)/([A-Za-z]*)")
HEX = re.compile(r"[a-fA-F0-9]+")
ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "0": "\0"}


@dataclass
class RegexLiteral:
    pattern: str
    flags: str


class LiteralReader:
    """Read the strings, regexes, arrays and objects used by ANSWER_RULES."""

    def __init__(self, source, start):
        self.source = source
        self.position = start

    def error(self, message):
        line = self.source.count("\n", 0, self.position) + 1
        column = self.position - self.source.rfind("\n", 0, self.position)
        return ValueError(f"第 {line} 行第 {column} 列：{message}")

    def skip_trivia(self):
        while match := TRIVIA.match(self.source, self.position):
            self.position = match.end()

    def accept(self, token):
        self.skip_trivia()
        if self.source.startswith(token, self.position):
            self.position += len(token)
            return True
        return False

    def expect(self, token):
        if not self.accept(token):
            raise self.error(f"预期 {token}")

    def string(self):
        quote = self.source[self.position]
        self.position += 1
        chars = []
        while self.position < len(self.source):
            char = self.source[self.position]
            self.position += 1
            if char == quote:
                value = "".join(chars)
                try:
                    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le")
                except UnicodeDecodeError as error:
                    raise self.error("字符串含无效的 Unicode 代理项") from error
            if char in "\r\n":
                raise self.error("字符串换行前需要转义")
            if char != "\\":
                chars.append(char)
                continue
            if self.position >= len(self.source):
                break
            escape = self.source[self.position]
            self.position += 1
            if escape in "\r\n":
                if escape == "\r" and self.source.startswith("\n", self.position):
                    self.position += 1
                continue
            if escape in "xu":
                chars.append(self.hex_escape(escape))
                continue
            if escape in "123456789" or (
                escape == "0" and self.source[self.position:self.position + 1].isdigit()
            ):
                raise self.error("不支持数字转义")
            chars.append(ESCAPES.get(escape, escape))
        raise self.error("字符串没有结束")

    def hex_escape(self, escape):
        start = self.position
        if escape == "u" and self.source.startswith("{", start):
            start += 1
            end = self.source.find("}", start)
            if end < 0:
                raise self.error("Unicode 转义缺少结束括号")
            self.position = end + 1
        else:
            end = start + (2 if escape == "x" else 4)
            self.position = end
        text = self.source[start:end]
        if not HEX.fullmatch(text) or end > len(self.source):
            raise self.error("无效的十六进制转义")
        number = int(text, 16)
        if number > 0x10FFFF:
            raise self.error("Unicode 转义超出范围")
        return chr(number)

    def regex(self):
        match = REGEX.match(self.source, self.position)
        if not match:
            raise self.error("无法读取正则表达式")
        pattern, flags = match.groups()
        self.position = match.end()
        if set(flags) - set("dgimsuvy") or len(flags) != len(set(flags)) or {"u", "v"} <= set(flags):
            raise self.error("无效的 JavaScript 正则标志")
        return RegexLiteral(pattern, flags)

    def key(self):
        self.skip_trivia()
        if self.source[self.position:self.position + 1] in ("'", '"'):
            return self.string()
        match = IDENTIFIER.match(self.source, self.position)
        if not match:
            raise self.error("预期对象字段名")
        self.position = match.end()
        return match.group()

    def value(self):
        self.skip_trivia()
        char = self.source[self.position:self.position + 1]
        if char in ("'", '"'):
            return self.string()
        if char == "/":
            return self.regex()
        if char == "[":
            self.position += 1
            return list(self.items("]", self.value))
        if char == "{":
            self.position += 1
            result = {}
            for key, value in self.items("}", self.member):
                if key in result:
                    raise self.error(f"字段 {key} 重复")
                result[key] = value
            return result
        raise self.error("预期字符串、正则、数组或对象字面量")

    def member(self):
        key = self.key()
        self.expect(":")
        return key, self.value()

    def items(self, closing, read):
        while not self.accept(closing):
            yield read()
            if self.accept(closing):
                return
            self.expect(",")


def matches_strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def matches_checkbox_item(item):
    return isinstance(item, str) or (
        isinstance(item, dict)
        and set(item) <= {"option", "fill"}
        and isinstance(item.get("option"), str)
        and isinstance(item.get("fill", ""), str)
    )


def convert_rule(rule, index):
    if not isinstance(rule, dict):
        raise ValueError(f"第 {index} 条规则需要是对象")
    kind = rule.get("type")
    question = rule.get("question", "")
    regex = rule.get("regex")
    value_key = "values" if kind == "sort" else "value"
    value = rule.get(value_key)

    fields = {"type", "question", "regex", value_key}
    if kind == "checkbox":
        fields.add("inverse")
    if rule.keys() - fields:
        extra = ", ".join(sorted(rule.keys() - fields))
        raise ValueError(f"第 {index} 条规则包含未识别的字段：{extra}")
    if not isinstance(question, str) or not isinstance(regex, RegexLiteral):
        raise ValueError(f"第 {index} 条规则的题干或正则格式不正确")

    if kind in ("radio", "fill"):
        valid = isinstance(value, str)
    elif kind == "checkbox":
        valid = isinstance(value, list) and all(map(matches_checkbox_item, value))
        valid = valid and matches_strings(rule.get("inverse", []))
    elif kind == "matrix":
        valid = isinstance(value, dict) and all(isinstance(item, str) for item in value.values())
    elif kind == "sort":
        valid = matches_strings(value)
    else:
        raise ValueError(f"第 {index} 条规则的题型无法识别：{kind!r}")
    if not valid:
        raise ValueError(f"第 {index} 条规则的答案格式不匹配题型 {kind}")

    result = {
        "question": question,
        "type": kind,
        "pattern": regex.pattern,
        "flags": regex.flags,
        "value": value,
    }
    if "inverse" in rule:
        result["inverse"] = rule["inverse"]
    return result


def export_rules(source):
    declarations = list(DECLARATION.finditer(source))
    if not declarations:
        raise ValueError("找不到 ANSWER_RULES，请传入升级前的原版 question.js")
    if len(declarations) != 1:
        raise ValueError("文件中有多处 ANSWER_RULES 声明")
    reader = LiteralReader(source, declarations[0].end())
    reader.expect("[")
    rules = list(reader.items("]", reader.value))
    reader.skip_trivia()
    if reader.source[reader.position:reader.position + 1] not in (";", ""):
        raise reader.error("ANSWER_RULES 需为独立数组声明")
    records = [convert_rule(rule, index) for index, rule in enumerate(rules, 1)]
    return {"format": "survey-legacy-rules", "version": 1, "records": records}


def main():
    parser = argparse.ArgumentParser(description="把旧版 question.js 的 ANSWER_RULES 导出为 JSON。")
    parser.add_argument("source", type=Path, help="升级前的 question.js 文件")
    parser.add_argument("output", type=Path, nargs="?", default=Path("legacy-answers.json"), help="输出文件")
    args = parser.parse_args()
    try:
        if args.source.resolve() == args.output.resolve():
            raise ValueError("输入和输出不能是同一个文件")
        data = export_rules(args.source.read_text(encoding="utf-8-sig"))
        args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError) as error:
        parser.exit(1, f"导出失败：{error}\n")
    print(f"已导出 {len(data['records'])} 条规则到 {args.output}")


if __name__ == "__main__":
    main()
