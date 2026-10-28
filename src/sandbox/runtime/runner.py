# Anvita sandbox runner (Python). Started as `python -u -c <this file>`; the host writes one JSON
# line to stdin ({code, inputs, files, limits}) and then talks over stdin/stdout:
#   sandbox → host  {"t": "tool", "id": n, "action": "...", "input": {...}}
#   host → sandbox  {"id": n, "ok": true, "output": ...} | {"id": n, "ok": false, "error": "..."}
#   sandbox → host  {"t": "done", "ok": bool, "result": ..., "error": "...", "files": [...]}
# Anything the user's code prints goes to stderr, which the host keeps as logs.
import ast
import base64
import datetime
import decimal
import io
import json
import os
import sys
import traceback
import types

_boot = json.loads(sys.stdin.readline())
_proto_in = sys.stdin
_proto_out = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
sys.stdin = io.StringIO("")

WORK = os.environ.get("ANVITA_WORK", "/work")
OUT = os.path.join(WORK, "out")
IN = os.path.join(WORK, "in")
os.makedirs(OUT, exist_ok=True)
os.makedirs(IN, exist_ok=True)
os.chdir(WORK)
_limits = _boot.get("limits") or {}
_MAX_FILES_BYTES = int(_limits.get("maxFilesBytes", 25 * 1024 * 1024))


def _default(o):
    try:
        import pandas as pd  # noqa: WPS433

        if isinstance(o, pd.DataFrame):
            return json.loads(o.to_json(orient="records", date_format="iso"))
        if isinstance(o, pd.Series):
            return json.loads(o.to_json(date_format="iso"))
    except Exception:
        pass
    if hasattr(o, "item") and callable(o.item):
        try:
            return o.item()
        except Exception:
            pass
    if hasattr(o, "tolist") and callable(o.tolist):
        return o.tolist()
    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    if isinstance(o, decimal.Decimal):
        return float(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return base64.b64encode(o).decode()
    return str(o)


def _send(msg):
    _proto_out.write(json.dumps(msg, default=_default) + "\n")
    _proto_out.flush()


class ToolError(Exception):
    """Raised when a tool call fails or is blocked by workspace policy."""


_seq = 0


def _call(action, payload):
    global _seq
    _seq += 1
    _send({"t": "tool", "id": _seq, "action": action, "input": payload or {}})
    line = _proto_in.readline()
    if not line:
        raise ToolError("The sandbox host closed the connection")
    msg = json.loads(line)
    if not msg.get("ok"):
        raise ToolError(msg.get("error") or "Tool call failed")
    return _wrap(msg.get("output"))


class Obj(dict):
    """A dict that also allows attribute access: inputs.order.id."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


def _wrap(v):
    if isinstance(v, dict):
        return Obj({k: _wrap(x) for k, x in v.items()})
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


class _ToolPath:
    def __init__(self, parts):
        self._parts = parts

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _ToolPath(self._parts + [name])

    def __call__(self, payload=None, **kwargs):
        merged = dict(payload or {})
        merged.update(kwargs)
        return _call(".".join(self._parts), merged)


class _Tools(_ToolPath):
    def __init__(self):
        super().__init__([])

    def call(self, action, payload=None, **kwargs):
        merged = dict(payload or {})
        merged.update(kwargs)
        return _call(action, merged)


def _safe_name(name):
    base = os.path.basename(str(name)).strip() or "file"
    return base.replace("/", "_").replace("\\", "_")


class _Files:
    out_dir = OUT
    in_dir = IN

    def path(self, name):
        return os.path.join(OUT, _safe_name(name))

    def save(self, name, data):
        p = self.path(name)
        mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
        with open(p, mode) as fh:
            fh.write(data)
        return p

    def text(self, name, text):
        return self.save(name, str(text))

    def json(self, name, data):
        return self.save(name, json.dumps(data, default=_default, indent=2))

    def csv(self, name, data):
        try:
            import pandas as pd

            df = data if isinstance(data, pd.DataFrame) else pd.DataFrame(data)
            df.to_csv(self.path(name), index=isinstance(data, pd.DataFrame) and data.index.name is not None)
            return self.path(name)
        except ImportError:
            import csv

            rows = list(data)
            with open(self.path(name), "w", newline="") as fh:
                if rows and isinstance(rows[0], dict):
                    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
                    w.writeheader()
                    w.writerows(rows)
                else:
                    csv.writer(fh).writerows(rows)
            return self.path(name)

    def excel(self, name, data):
        import pandas as pd

        sheets = data if isinstance(data, dict) else {"Sheet1": data}
        with pd.ExcelWriter(self.path(name)) as xw:
            for sheet, df in sheets.items():
                (df if isinstance(df, pd.DataFrame) else pd.DataFrame(df)).to_excel(xw, sheet_name=str(sheet)[:31])
        return self.path(name)

    def chart(self, name, fig=None):
        import matplotlib.pyplot as plt

        (fig or plt.gcf()).savefig(self.path(name), dpi=144, bbox_inches="tight")
        plt.close(fig or plt.gcf())
        return self.path(name)

    def pdf(self, name, text="", title=None, data=None, images=None, **_ignored):
        """A simple report PDF: title, Markdown-ish text (# headings, - bullets), optional table and images."""
        from fpdf import FPDF

        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        font = "Helvetica"
        for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
            if os.path.exists(path):
                pdf.add_font("DejaVu", "", path)
                pdf.add_font("DejaVu", "B", path)
                font = "DejaVu"
        def clean(s):
            s = str(s)
            return s if font == "DejaVu" else s.encode("latin-1", "replace").decode("latin-1")
        if title:
            pdf.set_font(font, "B", 18)
            pdf.multi_cell(0, 10, clean(title), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
        for line in str(text or "").splitlines():
            if line.startswith("#"):
                level = len(line) - len(line.lstrip("#"))
                pdf.set_font(font, "B", max(11, 17 - level * 2))
                pdf.multi_cell(0, 8, clean(line.lstrip("# ").strip()), new_x="LMARGIN", new_y="NEXT")
            elif line.strip().startswith(("- ", "* ")):
                pdf.set_font(font, "", 11)
                pdf.multi_cell(0, 6, clean("•  " + line.strip()[2:]), new_x="LMARGIN", new_y="NEXT")
            elif line.strip():
                pdf.set_font(font, "", 11)
                pdf.multi_cell(0, 6, clean(line), new_x="LMARGIN", new_y="NEXT")
            else:
                pdf.ln(3)
        if data is not None:
            try:
                import pandas as pd

                df = data if isinstance(data, pd.DataFrame) else pd.DataFrame(data)
                if df.index.name is not None:
                    df = df.reset_index()
                rows = [[str(c) for c in df.columns]] + [[(f"{v:,.2f}" if isinstance(v, float) else str(v)) for v in r] for r in df.head(200).itertuples(index=False)]
            except ImportError:
                rows = [list(map(str, r)) for r in data]
            pdf.ln(3)
            pdf.set_font(font, "", 9)
            with pdf.table() as table:
                for r in rows:
                    row = table.row()
                    for cell in r:
                        row.cell(clean(cell))
        for img in images or []:
            pdf.ln(3)
            pdf.image(img if os.path.isabs(img) else self.path(img), w=180)
        pdf.output(self.path(name))
        return self.path(name)

    def read(self, name, mode="r"):
        with open(os.path.join(IN, _safe_name(name)), mode) as fh:
            return fh.read()

    def list(self):
        return sorted(os.listdir(IN))


for f in _boot.get("files") or []:
    with open(os.path.join(IN, _safe_name(f["name"])), "wb") as fh:
        fh.write(base64.b64decode(f["b64"]))

inputs = _wrap(_boot.get("inputs") or {})
tools = _Tools()
files = _Files()

anvita = types.ModuleType("anvita")
anvita.inputs = inputs
anvita.steps = inputs.get("steps", Obj()) if isinstance(inputs, dict) else Obj()
anvita.tools = tools
anvita.files = files
anvita.ToolError = ToolError
sys.modules["anvita"] = anvita


def _compile(code):
    tree = ast.parse(code, "<step>", "exec")
    body = tree.body or [ast.Pass()]
    # Notebook-style: a trailing expression is the step's result.
    if isinstance(body[-1], ast.Expr):
        body[-1] = ast.Return(value=body[-1].value)
    fn = ast.FunctionDef(name="__anvita_main__", args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]), body=body, decorator_list=[], returns=None, type_params=[])
    mod = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(mod)
    return compile(mod, "<step>", "exec")


def _collect_files():
    out, total = [], 0
    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        if not os.path.isfile(p):
            continue
        size = os.path.getsize(p)
        total += size
        if total > _MAX_FILES_BYTES:
            print(f"[anvita] skipped {name}: output files exceed {_MAX_FILES_BYTES // (1024 * 1024)} MB", file=sys.stderr)
            continue
        with open(p, "rb") as fh:
            out.append({"name": name, "b64": base64.b64encode(fh.read()).decode()})
    return out


def _format_error(exc):
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == "<step>"]
    where = f" (line {frames[-1].lineno})" if frames else ""
    tb = "".join(traceback.format_list(frames)) if frames else ""
    return f"{type(exc).__name__}: {exc}{where}\n{tb}".strip()


_g = {"__name__": "__main__", "inputs": inputs, "tools": tools, "files": files, "ToolError": ToolError, "steps": anvita.steps}
try:
    exec(_compile(_boot["code"]), _g)
    result = _g["__anvita_main__"]()
    if result is None and "result" in _g:
        result = _g["result"]
    _send({"t": "done", "ok": True, "result": result, "files": _collect_files()})
except SyntaxError as exc:
    _send({"t": "done", "ok": False, "error": f"SyntaxError: {exc.msg} (line {exc.lineno})", "files": []})
except BaseException as exc:  # noqa: B902 — report everything, including SystemExit
    _send({"t": "done", "ok": False, "error": _format_error(exc), "files": _collect_files()})
