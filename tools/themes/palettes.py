"""Palette table for gen.py. `colors` are the source values (official
palettes for ports); gen.py applies the legibility rules on top."""

def T(id, name, mode, group, tagline, about, colors, ui=None, **kw):
    return dict(id=id, name=name, mode=mode, group=group, tagline=tagline,
                about=about, colors=colors, ui=ui, **kw)

def ansi(bg, fg, cursor, sel, n, b, **extra):
    keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
    c = {'background': bg, 'foreground': fg, 'cursor': cursor, 'selectionBackground': sel}
    c.update(dict(zip(keys, n)))
    c.update({'bright' + k[0].upper() + k[1:]: v for k, v in zip(keys, b)})
    c.update(extra)
    return c

THEMES = [
# ---------------------------------------------------------------- axn family
T('axn-dark', 'Axn Dark', 'dark', 'axn', 'Warm near-black. The default.',
  """axn-term's own theme (default). Warm near-black from the axn-term website's
dark palette. Coral (red) is the "needs you" colour; the UI accent is the
site's link blue.""",
  ansi('#141110', '#E9E5E2', '#F0A3AA', '#3A3330',
       ['#2A2523', '#F45B69', '#3DBB72', '#E3B341', '#4F9FD0', '#C08FD8', '#59C3C3', '#CFC9C5'],
       ['#877D79', '#F0A3AA', '#6FD396', '#F0C869', '#82C6DC', '#D8B4F0', '#A2D7D7', '#F7F4F2'],
       orange='#F97316', violet='#C08FD8'),
  ui=dict(bg='#141110', bgSecondary='#1C1918', surface='#1C1918', surfaceHover='#26211F',
          text='#E9E5E2', textSecondary='#AAA6A3', textInverted='#141110', border='#36312F',
          accent='#82C6DC', accentHover='#A2D7D7', cursor='#F0A3AA')),

T('axn-light', 'Axn Light', 'light', 'axn', 'The website\'s paper and ink.',
  """Light companion to Axn Dark: the axn-term website's paper (#EBEBEB chrome,
#F5F5F4 terminal) and obsidian ink. Coral darkened to stay readable on paper;
link blue as the accent.""",
  ansi('#F5F5F4', '#1A1615', '#B8323F', '#D3E4EB',
       ['#2A2726', '#B8323F', '#1E7A46', '#8A5F00', '#175A7E', '#8A47A6', '#1C7475', '#76706C'],
       ['#6F6865', '#D04452', '#26904F', '#A87400', '#2873A0', '#A05EBE', '#278C8C', '#A8A29E'],
       orange='#B4500C', violet='#8A47A6'),
  ui=dict(bg='#EBEBEB', bgSecondary='#F5F5F4', surface='#F5F5F4', surfaceHover='#E0DFDD',
          text='#0F0B0A', textSecondary='#4F4C4A', textInverted='#F5F5F4', border='#C9C7C4',
          accent='#175A7E', accentHover='#1E6F9A', cursor='#B8323F')),

T('axn-dusk', 'Axn Dusk', 'dark', 'axn', 'Softer, dimmer, for long nights.',
  """A dim variant of Axn Dark for long sessions: lifted warm grey instead of
near-black, lower overall contrast, desaturated accents. Turquoise accent;
coral still means "needs you".""",
  ansi('#262221', '#D8D1CC', '#E9A3A9', '#433B38',
       ['#38322F', '#E5747E', '#7DBF8E', '#D9B25E', '#7AAFD2', '#C49ED8', '#72BDBB', '#BBB3AE'],
       ['#8F8580', '#EEA0A7', '#9FD3AC', '#E6C887', '#9CC6E2', '#D6BAE6', '#9AD1CF', '#ECE6E2'],
       orange='#E8925A', violet='#C49ED8'),
  ui=dict(bg='#262221', bgSecondary='#2E2928', surface='#2E2928', surfaceHover='#38322F',
          text='#D8D1CC', textSecondary='#A69D98', textInverted='#262221', border='#4A4340',
          accent='#72BDBB', accentHover='#9AD1CF', cursor='#E9A3A9')),

T('axn-contrast', 'Axn Contrast', 'dark', 'axn', 'Every colour at 7:1 or more.',
  """High-contrast Axn for bright rooms, small fonts and low vision: every ANSI
colour, bright black included, reads at 7:1 or more (WCAG AAA). Visible
borders and a strong selection.""",
  ansi('#0A0807', '#FFFFFF', '#FF9AA3', '#4A3F3B',
       ['#3A3330', '#FF8A94', '#5FE597', '#FFD35C', '#86C8FF', '#E3AEFF', '#6FE7E7', '#EDEDED'],
       ['#B5ACA8', '#FFB3BA', '#93F2B8', '#FFE38F', '#B3DCFF', '#EFCCFF', '#A6F2F2', '#FFFFFF'],
       orange='#FFA463', violet='#E3AEFF'),
  ui=dict(bg='#0A0807', bgSecondary='#15110F', surface='#15110F', surfaceHover='#2A2421',
          text='#FFFFFF', textSecondary='#D6CFCB', textInverted='#0A0807', border='#7A706B',
          accent='#86C8FF', accentHover='#B3DCFF', cursor='#FF9AA3'),
  fgTarget=7.0),

# ---------------------------------------------------------------- improved ports
T('ayu-dark', 'Ayu Dark', 'dark', 'improved', 'Ayu\'s deep blue-black, warm orange accent.',
  """Ayu Dark (github.com/ayu-theme). Magenta was Ayu's pale yellow (#FAE994),
indistinguishable from yellow in most CLIs; it now uses Ayu's purple. UI
colours from Ayu's editor palette.""",
  ansi('#0B0E14', '#BFBDB6', '#E6B450', '#273747',
       ['#11151C', '#EA6C73', '#91B362', '#F9AF4F', '#53BDFA', '#D2A6FF', '#90E1C6', '#C7C7C7'],
       ['#686868', '#F07178', '#AAD94C', '#FFB454', '#59C2FF', '#DFBFFF', '#95E6CB', '#FFFFFF']),
  ui=dict(bg='#0B0E14', bgSecondary='#0D1017', surface='#0F131A', surfaceHover='#131721',
          border='#1E232B', textSecondary='#8A8986', accent='#E6B450')),

T('ayu-light', 'Ayu Light', 'light', 'improved', 'Bright and airy, orange accent.',
  """Ayu Light (github.com/ayu-theme). Its yellows, cyans and blues were too pale
for text on white (down to 1.8:1); they keep their hue and are darkened. White
was pure white on a near-white background; it is a mid grey now.""",
  ansi('#FCFCFC', '#5C6166', '#FF9940', '#E6EAF0',
       ['#41474D', '#E65050', '#6CBF43', '#E6BA7E', '#399EE6', '#A37ACC', '#4CBF99', '#8A9199'],
       ['#787B80', '#F07171', '#86B300', '#F2AE49', '#55B4D4', '#A37ACC', '#4CBF99', '#ADAEB1']),
  ui=dict(bg='#F8F9FA', bgSecondary='#FCFCFC', surface='#FCFCFC', surfaceHover='#EEF0F2',
          border='#DCDFE3', accent='#FA8D3E')),

T('breeze-dark', 'Breeze Dark', 'dark', 'improved', 'KDE Plasma\'s own.',
  """Breeze Dark (KDE Plasma / Konsole). The selection was Breeze's bright
highlight blue, which left white text at 2.4:1; it is darkened. Bright red and
bright magenta were darker than their normal shades; they are lifted.""",
  ansi('#232627', '#FCFCFC', '#FCFCFC', '#3DAEE9',
       ['#232627', '#ED1515', '#11D116', '#F67400', '#1D99F3', '#9B59B6', '#1ABC9C', '#FCFCFC'],
       ['#7F8C8D', '#C0392B', '#1CDC9A', '#FDBC4B', '#3DAEE9', '#8E44AD', '#16A085', '#FFFFFF'],
       orange='#F67400', violet='#9B59B6'),
  ui=dict(bg='#202326', bgSecondary='#1D1F22', surface='#292C30', surfaceHover='#313539',
          textSecondary='#A1A9B1', border='#3A3F45', accent='#3DAEE9', accentHover='#57BDEC')),

T('catppuccin-latte', 'Catppuccin Latte', 'light', 'improved', 'Pastel, gentle, light.',
  """Catppuccin Latte (catppuccin.com). UI colours from Latte's mantle, crust and
surface layers. Yellow, green and pink were too light for text on base (down to
2.3:1); they are darkened within their hue.""",
  ansi('#EFF1F5', '#4C4F69', '#DC8A78', '#CCD0DA',
       ['#5C5F77', '#D20F39', '#40A02B', '#DF8E1D', '#1E66F5', '#EA76CB', '#179299', '#ACB0BE'],
       ['#6C6F85', '#D20F39', '#40A02B', '#DF8E1D', '#1E66F5', '#EA76CB', '#179299', '#BCC0CC'],
       orange='#FE640B', violet='#8839EF'),
  ui=dict(bg='#E6E9EF', bgSecondary='#EFF1F5', surface='#EFF1F5', surfaceHover='#DCE0E8',
          border='#BCC0CC', textSecondary='#6C6F85', accent='#8839EF')),

T('catppuccin-mocha', 'Catppuccin Mocha', 'dark', 'improved', 'Pastel on deep violet.',
  """Catppuccin Mocha (catppuccin.com). UI colours from Mocha's mantle, crust and
surface layers, accent mauve. Bright black was surface2 (2.5:1); it is lifted
toward overlay1 so comments stay readable.""",
  ansi('#1E1E2E', '#CDD6F4', '#F5E0DC', '#45475A',
       ['#45475A', '#F38BA8', '#A6E3A1', '#F9E2AF', '#89B4FA', '#F5C2E7', '#94E2D5', '#BAC2DE'],
       ['#585B70', '#F38BA8', '#A6E3A1', '#F9E2AF', '#89B4FA', '#F5C2E7', '#94E2D5', '#A6ADC8'],
       orange='#FAB387', violet='#CBA6F7'),
  ui=dict(bg='#181825', bgSecondary='#1E1E2E', surface='#1E1E2E', surfaceHover='#313244',
          border='#45475A', textSecondary='#A6ADC8', accent='#CBA6F7', accentHover='#B4BEFE')),

T('dracula', 'Dracula', 'dark', 'improved', 'The classic purple vampire.',
  """Dracula (draculatheme.com). Unchanged terminal colours; adds Dracula's own
UI layers (darker sidebar, current-line surface, comment-blue secondary text)
and its purple as the accent.""",
  ansi('#282A36', '#F8F8F2', '#F8F8F2', '#44475A',
       ['#21222C', '#FF5555', '#50FA7B', '#F1FA8C', '#BD93F9', '#FF79C6', '#8BE9FD', '#F8F8F2'],
       ['#6272A4', '#FF6E6E', '#69FF94', '#FFFFA5', '#D6ACFF', '#FF92DF', '#A4FFFF', '#FFFFFF'],
       orange='#FFB86C', violet='#BD93F9'),
  ui=dict(bg='#21222C', bgSecondary='#282A36', surface='#282A36', surfaceHover='#343746',
          border='#44475A', textSecondary='#9AA5CE', accent='#BD93F9')),

T('gruvbox-dark', 'Gruvbox Dark', 'dark', 'improved', 'Retro groove, warm and earthy.',
  """Gruvbox Dark (github.com/morhetz/gruvbox). Normal red was 2.7:1 on bg0; it
is lifted. UI colours from Gruvbox's bg0_h/bg1/bg2 layers, accent yellow.""",
  ansi('#282828', '#EBDBB2', '#EBDBB2', '#504945',
       ['#282828', '#CC241D', '#98971A', '#D79921', '#458588', '#B16286', '#689D6A', '#A89984'],
       ['#928374', '#FB4934', '#B8BB26', '#FABD2F', '#83A598', '#D3869B', '#8EC07C', '#EBDBB2'],
       orange='#FE8019', violet='#D3869B'),
  ui=dict(bg='#1D2021', bgSecondary='#282828', surface='#282828', surfaceHover='#3C3836',
          border='#504945', textSecondary='#A89984', accent='#FABD2F')),

T('one-dark', 'One Dark', 'dark', 'improved', 'Atom\'s calm blue-grey.',
  """One Dark (Atom). Bright black was 2.0:1, so comments and autosuggestions
vanished; it uses One Dark Pro's comment grey, lifted to 3.5:1. Foreground
lifted from 6.6:1. UI layers from Atom's sidebar and borders.""",
  ansi('#282C34', '#ABB2BF', '#528BFF', '#3E4452',
       ['#282C34', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#ABB2BF'],
       ['#7F848E', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#FFFFFF'],
       orange='#D19A66', violet='#C678DD'),
  ui=dict(bg='#21252B', bgSecondary='#282C34', surface='#282C34', surfaceHover='#2C313A',
          border='#3E4452', textSecondary='#9DA5B4', accent='#61AFEF')),

T('solarized-dark', 'Solarized Dark', 'dark', 'improved', 'Precision colours, low contrast.',
  """Solarized Dark (ethanschoonover.com/solarized). The classic mapping put
bright black on base03 (the background itself, 1.0:1) and greyed out four
bright colours. Bright black is now base01 lifted to 3.5:1; the bright
colours are lightened versions of their normal accents. Foreground nudged to
6:1; Solarized stays deliberately soft.""",
  ansi('#002B36', '#839496', '#93A1A1', '#073642',
       ['#073642', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#EEE8D5'],
       ['#586E75', '#CB4B16', '#A3B82B', '#D6A92A', '#5CA8E0', '#6C71C4', '#5BC0B6', '#FDF6E3'],
       orange='#CB4B16', violet='#6C71C4'),
  ui=dict(bg='#002B36', bgSecondary='#073642', surface='#073642', surfaceHover='#0E4452',
          border='#24525E', textSecondary='#93A1A1', accent='#268BD2', accentHover='#2AA198'),
  fgTarget=6.0),

T('solarized-light', 'Solarized Light', 'light', 'improved', 'Precision colours on cream.',
  """Solarized Light (ethanschoonover.com/solarized). Green, yellow and cyan
were at or under 3:1 on base3; they are darkened within their hue. Foreground
nudged to 6:1; secondary UI text was base1 (2.4:1) and is darkened.""",
  ansi('#FDF6E3', '#657B83', '#586E75', '#EEE8D5',
       ['#073642', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#93A1A1'],
       ['#586E75', '#CB4B16', '#859900', '#B58900', '#268BD2', '#6C71C4', '#2AA198', '#EEE8D5'],
       orange='#CB4B16', violet='#6C71C4'),
  ui=dict(bg='#EEE8D5', bgSecondary='#FDF6E3', surface='#FDF6E3', surfaceHover='#E4DCC4',
          border='#D3CBB3', textSecondary='#657B83', accent='#268BD2', accentHover='#2AA198'),
  fgTarget=6.0),

T('tokyo-night', 'Tokyo Night', 'dark', 'improved', 'Neon city at night.',
  """Tokyo Night (github.com/enkia/tokyo-night-vscode-theme). Bright black was
1.9:1; it is lifted to 3.5:1. UI layers from Tokyo Night's sidebar and
highlight colours, accent blue.""",
  ansi('#1A1B26', '#C0CAF5', '#C0CAF5', '#33467C',
       ['#15161E', '#F7768E', '#9ECE6A', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#A9B1D6'],
       ['#414868', '#F7768E', '#9ECE6A', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#C0CAF5'],
       orange='#FF9E64', violet='#BB9AF7'),
  ui=dict(bg='#16161E', bgSecondary='#1A1B26', surface='#1A1B26', surfaceHover='#292E42',
          border='#2A2F45', textSecondary='#787C99', accent='#7AA2F7')),

# ---------------------------------------------------------------- new ports
T('nord', 'Nord', 'dark', 'new', 'Arctic, north-bluish calm.',
  """Nord (nordtheme.com). Polar Night backgrounds, Snow Storm text, Frost
accents. Bright black is nord3's brightened comment shade, lifted to 3.5:1.""",
  ansi('#2E3440', '#D8DEE9', '#D8DEE9', '#434C5E',
       ['#3B4252', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#88C0D0', '#E5E9F0'],
       ['#616E88', '#BF616A', '#A3BE8C', '#EBCB8B', '#81A1C1', '#B48EAD', '#8FBCBB', '#ECEFF4'],
       orange='#D08770', violet='#B48EAD'),
  ui=dict(bg='#2A303C', bgSecondary='#2E3440', surface='#3B4252', surfaceHover='#434C5E',
          border='#4C566A', textSecondary='#A5AFC2', accent='#88C0D0')),

T('rose-pine', 'Rosé Pine', 'dark', 'new', 'All natural pine, faux fur and soho vibes.',
  """Rosé Pine (rosepinetheme.com), main variant. Pine (green) was 3.3:1 on
base; it is lifted. UI layers from base, surface and overlay; accent iris.""",
  ansi('#191724', '#E0DEF4', '#524F67', '#403D52',
       ['#26233A', '#EB6F92', '#31748F', '#F6C177', '#9CCFD8', '#C4A7E7', '#EBBCBA', '#E0DEF4'],
       ['#6E6A86', '#EB6F92', '#31748F', '#F6C177', '#9CCFD8', '#C4A7E7', '#EBBCBA', '#E0DEF4'],
       orange='#F6C177', violet='#C4A7E7'),
  ui=dict(bg='#191724', bgSecondary='#1F1D2E', surface='#1F1D2E', surfaceHover='#26233A',
          border='#403D52', textSecondary='#908CAA', accent='#C4A7E7', accentHover='#EBBCBA')),

T('rose-pine-dawn', 'Rosé Pine Dawn', 'light', 'new', 'Rosé Pine at sunrise.',
  """Rosé Pine Dawn (rosepinetheme.com), the light variant. Gold, rose and foam
were too pale for text on base; they are darkened within their hue. Black and
white swapped to the light-theme convention (black = text tone).""",
  ansi('#FAF4ED', '#575279', '#9893A5', '#DFDAD9',
       ['#575279', '#B4637A', '#286983', '#EA9D34', '#56949F', '#907AA9', '#D7827E', '#9893A5'],
       ['#797593', '#B4637A', '#286983', '#EA9D34', '#56949F', '#907AA9', '#D7827E', '#CECACD'],
       orange='#EA9D34', violet='#907AA9'),
  ui=dict(bg='#F2E9E1', bgSecondary='#FFFAF3', surface='#FFFAF3', surfaceHover='#F4EDE8',
          border='#DFDAD9', textSecondary='#797593', accent='#907AA9', accentHover='#286983'),
  ),

T('kanagawa', 'Kanagawa', 'dark', 'new', 'Hokusai\'s Great Wave in ink and indigo.',
  """Kanagawa Wave (github.com/rebelot/kanagawa.nvim). Sumi ink backgrounds,
Fuji white text. Autumn red and autumn green were under 4.5:1 on sumiInk3;
they are lifted.""",
  ansi('#1F1F28', '#DCD7BA', '#C8C093', '#2D4F67',
       ['#16161D', '#C34043', '#76946A', '#C0A36E', '#7E9CD8', '#957FB8', '#6A9589', '#C8C093'],
       ['#727169', '#E82424', '#98BB6C', '#E6C384', '#7FB4CA', '#938AA9', '#7AA89F', '#DCD7BA'],
       orange='#FFA066', violet='#957FB8'),
  ui=dict(bg='#16161D', bgSecondary='#1F1F28', surface='#1F1F28', surfaceHover='#2A2A37',
          border='#363646', textSecondary='#A6A69C', accent='#7E9CD8', accentHover='#7FB4CA')),

T('everforest-dark', 'Everforest Dark', 'dark', 'new', 'Green-based, easy on the eyes.',
  """Everforest Dark, medium (github.com/sainnhe/everforest). Soft green-grey
backgrounds designed for long reading; accent green.""",
  ansi('#2D353B', '#D3C6AA', '#D3C6AA', '#475258',
       ['#343F44', '#E67E80', '#A7C080', '#DBBC7F', '#7FBBB3', '#D699B6', '#83C092', '#D3C6AA'],
       ['#859289', '#E67E80', '#A7C080', '#DBBC7F', '#7FBBB3', '#D699B6', '#83C092', '#D3C6AA'],
       orange='#E69875', violet='#D699B6'),
  ui=dict(bg='#272E33', bgSecondary='#2D353B', surface='#343F44', surfaceHover='#3D484D',
          border='#475258', textSecondary='#9DA9A0', accent='#A7C080', accentHover='#83C092')),

T('gruvbox-light', 'Gruvbox Light', 'light', 'new', 'Retro groove on warm parchment.',
  """Gruvbox Light (github.com/morhetz/gruvbox). Uses Gruvbox's darker "faded"
accents for normal colours (the neutral ones are too light for text on bg0)
and the neutral accents for brights.""",
  ansi('#FBF1C7', '#3C3836', '#3C3836', '#D5C4A1',
       ['#3C3836', '#9D0006', '#79740E', '#B57614', '#076678', '#8F3F71', '#427B58', '#7C6F64'],
       ['#928374', '#CC241D', '#98971A', '#D79921', '#458588', '#B16286', '#689D6A', '#D5C4A1'],
       orange='#AF3A03', violet='#8F3F71'),
  ui=dict(bg='#F2E5BC', bgSecondary='#FBF1C7', surface='#FBF1C7', surfaceHover='#EBDBB2',
          border='#D5C4A1', textSecondary='#665C54', accent='#076678', accentHover='#427B58')),
]
