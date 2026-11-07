#!/usr/bin/env python3
"""X11 input driver for the axn-term file-drop flow (DISPLAY selects the X
server — the adapter runs a private one). Standard library + GTK 3 only.

  x11drive.py source FILE X Y    GTK window at X,Y that drags FILE as text/uri-list,
                                 like a file manager does
  x11drive.py drag X1 Y1 X2 Y2   XTEST press, move, release (a real XDND drag)
  x11drive.py click X Y [BTN]    XTEST click, left by default, 3 = right (also gives the window keyboard focus)
  x11drive.py key KEYS           XTEST key press + release (e.g. Return, Shift_L+Insert)
  x11drive.py type TEXT          XTEST key presses for each character of TEXT
  x11drive.py clipboard TEXT     GTK process owning CLIPBOARD and PRIMARY with TEXT
  x11drive.py get [primary]      print the CLIPBOARD (or PRIMARY) contents as text
  x11drive.py find NAME          "id x y w h" per mapped top-level window named NAME, largest first
  x11drive.py close ID           WM_DELETE_WINDOW — what the title bar's close button sends
"""
import ctypes, sys, time

a = sys.argv[1:]

if a[0] == "source":
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    path, x, y = a[1], int(a[2]), int(a[3])
    uri = GLib.filename_to_uri(path, None)
    w = Gtk.Window(title="drag-source")
    w.set_default_size(200, 200)
    w.move(x, y)
    box = Gtk.EventBox()
    box.add(Gtk.Label(label="drag me"))
    box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], Gdk.DragAction.COPY)
    box.drag_source_add_uri_targets()
    box.connect("drag-data-get", lambda *args: args[2].set_uris([uri]))
    box.connect("drag-end", lambda *args: print("drag-end", flush=True))
    w.add(box)
    w.connect("destroy", Gtk.main_quit)
    w.show_all()
    GLib.timeout_add(300, lambda: (print("source ready", flush=True), False)[1])
    Gtk.main()
    sys.exit(0)

if a[0] == "clipboard":
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib
    # Owns the selections until killed; no clipboard manager runs here.
    for sel in (Gdk.SELECTION_CLIPBOARD, Gdk.SELECTION_PRIMARY):
        Gtk.Clipboard.get(sel).set_text(a[1], -1)
    GLib.timeout_add(100, lambda: (print("clipboard ready", flush=True), False)[1])
    Gtk.main()
    sys.exit(0)

if a[0] == "get":
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk
    # Requests the selection like any pasting app would — an owner that
    # stopped serving (or lost it on drop) answers empty.
    sel = Gdk.SELECTION_PRIMARY if len(a) > 1 and a[1] == "primary" else Gdk.SELECTION_CLIPBOARD
    text = Gtk.Clipboard.get(sel).wait_for_text()
    sys.stdout.write(text or "")
    sys.exit(0)

x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xt = ctypes.cdll.LoadLibrary("libXtst.so.6")
VP, UL = ctypes.c_void_p, ctypes.c_ulong
x11.XOpenDisplay.restype = VP
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XSync.argtypes = [VP, ctypes.c_int]
x11.XDefaultRootWindow.argtypes = [VP]
x11.XDefaultRootWindow.restype = UL
x11.XInternAtom.argtypes = [VP, ctypes.c_char_p, ctypes.c_int]
x11.XInternAtom.restype = UL
x11.XFetchName.argtypes = [VP, UL, ctypes.POINTER(ctypes.c_char_p)]
x11.XQueryTree.argtypes = [VP, UL, ctypes.POINTER(UL), ctypes.POINTER(UL), ctypes.POINTER(ctypes.POINTER(UL)), ctypes.POINTER(ctypes.c_uint)]
xt.XTestFakeMotionEvent.argtypes = [VP, ctypes.c_int, ctypes.c_int, ctypes.c_int, UL]
xt.XTestFakeButtonEvent.argtypes = [VP, ctypes.c_uint, ctypes.c_int, UL]
d = x11.XOpenDisplay(None)
if not d:
    sys.exit("cannot open display")
d = VP(d)


class Attrs(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
                ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", VP), ("root", UL),
                ("class", ctypes.c_int), ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int),
                ("backing_store", ctypes.c_int), ("backing_planes", UL), ("backing_pixel", UL),
                ("save_under", ctypes.c_int), ("colormap", UL), ("map_installed", ctypes.c_int),
                ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long),
                ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
                ("override_redirect", ctypes.c_int), ("screen", VP)]


x11.XGetWindowAttributes.argtypes = [VP, UL, ctypes.POINTER(Attrs)]


def children(win):
    root, parent, kids, n = UL(), UL(), ctypes.POINTER(UL)(), ctypes.c_uint()
    if not x11.XQueryTree(d, win, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(n)):
        return []
    return [kids[i] for i in range(n.value)]


def name(win):
    p = ctypes.c_char_p()
    x11.XFetchName(d, win, ctypes.byref(p))
    return p.value.decode() if p.value else ""


def attrs(win):
    at = Attrs()
    return at if x11.XGetWindowAttributes(d, win, ctypes.byref(at)) else None


def move(x, y):
    xt.XTestFakeMotionEvent(d, -1, int(x), int(y), 0)
    x11.XSync(d, 0)


def btn(down, button=1):
    xt.XTestFakeButtonEvent(d, button, 1 if down else 0, 0)
    x11.XSync(d, 0)


cmd = a[0]
if cmd == "drag":
    x1, y1, x2, y2 = map(int, a[1:5])
    move(x1, y1); time.sleep(0.3); btn(True); time.sleep(0.2)
    steps = 40
    for i in range(1, steps + 1):
        move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        time.sleep(0.03)
    time.sleep(0.5); move(x2 + 2, y2 + 2); time.sleep(0.5)
    btn(False); time.sleep(0.3)
elif cmd == "find":
    # Largest first; GTK also maps 1x1 helper windows under the app's name.
    found = []
    for w in children(x11.XDefaultRootWindow(d)):
        at = attrs(w)
        if name(w) == a[1] and at and at.map_state == 2 and at.width > 10 and at.height > 10:
            found.append((at.width * at.height, w, at))
    for _, w, at in sorted(found, key=lambda f: -f[0]):
        print(w, at.x, at.y, at.width, at.height)
elif cmd == "shot":
    # PNG of the whole test display (debugging flows; never the user's screen).
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    root = Gdk.get_default_root_window()
    Gdk.pixbuf_get_from_window(root, 0, 0, root.get_width(), root.get_height()).savev(a[1], "png", [], [])
elif cmd == "click":
    b = int(a[3]) if len(a) > 3 else 1
    move(a[1], a[2]); time.sleep(0.1); btn(True, b); time.sleep(0.05); btn(False, b)
elif cmd in ("key", "type"):
    x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    x11.XStringToKeysym.restype = UL
    x11.XKeysymToKeycode.argtypes = [VP, UL]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XKeycodeToKeysym.argtypes = [VP, ctypes.c_ubyte, ctypes.c_int]
    x11.XKeycodeToKeysym.restype = UL
    xt.XTestFakeKeyEvent.argtypes = [VP, ctypes.c_uint, ctypes.c_int, UL]

    def keycode(name):
        sym = x11.XStringToKeysym(name.encode())
        code = x11.XKeysymToKeycode(d, sym)
        if not code:
            sys.exit("unknown keysym " + name)
        return sym, code

    def press(names):
        codes = [keycode(n)[1] for n in names]
        for c in codes:
            xt.XTestFakeKeyEvent(d, c, 1, 0); x11.XSync(d, 0); time.sleep(0.02)
        for c in reversed(codes):
            xt.XTestFakeKeyEvent(d, c, 0, 0); x11.XSync(d, 0); time.sleep(0.02)

    if cmd == "key":
        press(a[1].split("+"))
    else:
        names = {" ": "space", "/": "slash", ".": "period", "-": "minus", "_": "underscore",
                 "$": "dollar", "(": "parenleft", ")": "parenright", "+": "plus", "'": "apostrophe",
                 '"': "quotedbl", "=": "equal", ":": "colon", ",": "comma", "~": "asciitilde"}
        for ch in a[1]:
            name = names.get(ch, ch)
            sym, code = keycode(name)
            # Shifted characters sit in the keycode's second column.
            shifted = x11.XKeycodeToKeysym(d, code, 0) != sym
            press(["Shift_L", name] if shifted else [name])
elif cmd == "close":
    class ClientMessage(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", UL), ("send_event", ctypes.c_int), ("display", VP),
                    ("window", UL), ("message_type", UL), ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]

    class XEvent(ctypes.Union):
        _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]

    x11.XSendEvent.argtypes = [VP, UL, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
    win = int(a[1])
    ev = XEvent()
    ev.xclient.type = 33  # ClientMessage
    ev.xclient.window = win
    ev.xclient.message_type = x11.XInternAtom(d, b"WM_PROTOCOLS", 0)
    ev.xclient.format = 32
    ev.xclient.data[0] = x11.XInternAtom(d, b"WM_DELETE_WINDOW", 0)
    ev.xclient.data[1] = 0  # CurrentTime
    x11.XSendEvent(d, win, 0, 0, ctypes.byref(ev))
    x11.XSync(d, 0)
else:
    sys.exit("unknown command " + cmd)
