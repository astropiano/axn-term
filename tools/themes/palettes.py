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

# ---------------------------------------------------------------- popular additions
T('github-dark', 'GitHub Dark', 'dark', 'new', 'github.com after dark.',
  """GitHub Dark Default (github.com/primer/github-vscode-theme), colours from
@primer/primitives 7.10 with the theme's own text overrides. UI layers from
GitHub's canvas inset/default/overlay; accent blue.""",
  ansi('#0D1117', '#E6EDF3', '#2F81F7', '#1E4273',
       ['#484F58', '#FF7B72', '#3FB950', '#D29922', '#58A6FF', '#BC8CFF', '#39C5CF', '#B1BAC4'],
       ['#6E7681', '#FFA198', '#56D364', '#E3B341', '#79C0FF', '#D2A8FF', '#56D4DD', '#FFFFFF'],
       orange='#DB6D28', violet='#BC8CFF'),
  ui=dict(bg='#010409', bgSecondary='#0D1117', surface='#161B22', surfaceHover='#21262D',
          border='#30363D', textSecondary='#7D8590', accent='#2F81F7', accentHover='#58A6FF')),

T('github-light', 'GitHub Light', 'light', 'new', 'github.com, the familiar white.',
  """GitHub Light Default (github.com/primer/github-vscode-theme), colours from
@primer/primitives 7.10 with the theme's own text overrides. GitHub's ANSI
brights are already tuned for white; UI layers from its canvas and borders.""",
  ansi('#FFFFFF', '#1F2328', '#0969DA', '#BBDFFF',
       ['#24292F', '#CF222E', '#116329', '#4D2D00', '#0969DA', '#8250DF', '#1B7C83', '#6E7781'],
       ['#57606A', '#A40E26', '#1A7F37', '#633C01', '#218BFF', '#A475F9', '#3192AA', '#8C959F'],
       orange='#BC4C00', violet='#8250DF'),
  ui=dict(bg='#F6F8FA', bgSecondary='#FFFFFF', surface='#FFFFFF', surfaceHover='#EAEEF2',
          border='#D0D7DE', text='#1F2328', textSecondary='#656D76', accent='#0969DA')),

T('catppuccin-frappe', 'Catppuccin Frappé', 'dark', 'new', 'Pastel on muted slate.',
  """Catppuccin Frappé (catppuccin.com), the lightest of the dark flavours. ANSI
colours are Catppuccin's official terminal mapping (palette ansiColors);
bright black (surface2) is lifted to 3.5:1. UI from mantle, base and surface
layers; accent mauve.""",
  ansi('#303446', '#C6D0F5', '#F2D5CF', '#51576D',
       ['#51576D', '#E78284', '#A6D189', '#E5C890', '#8CAAEE', '#F4B8E4', '#81C8BE', '#A5ADCE'],
       ['#626880', '#E67172', '#8EC772', '#D9BA73', '#7B9EF0', '#F2A4DB', '#5ABFB5', '#B5BFE2'],
       orange='#EF9F76', violet='#CA9EE6'),
  ui=dict(bg='#292C3C', bgSecondary='#303446', surface='#303446', surfaceHover='#414559',
          border='#51576D', textSecondary='#A5ADCE', accent='#CA9EE6', accentHover='#BABBF1')),

T('catppuccin-macchiato', 'Catppuccin Macchiato', 'dark', 'new', 'Pastel on deep slate.',
  """Catppuccin Macchiato (catppuccin.com), between Frappé and Mocha. ANSI
colours are Catppuccin's official terminal mapping (palette ansiColors);
bright black (surface2) is lifted to 3.5:1. UI from mantle, base and surface
layers; accent mauve.""",
  ansi('#24273A', '#CAD3F5', '#F4DBD6', '#494D64',
       ['#494D64', '#ED8796', '#A6DA95', '#EED49F', '#8AADF4', '#F5BDE6', '#8BD5CA', '#A5ADCB'],
       ['#5B6078', '#EC7486', '#8CCF7F', '#E1C682', '#78A1F6', '#F2A9DD', '#63CBC0', '#B8C0E0'],
       orange='#F5A97F', violet='#C6A0F6'),
  ui=dict(bg='#1E2030', bgSecondary='#24273A', surface='#24273A', surfaceHover='#363A4F',
          border='#494D64', textSecondary='#A5ADCB', accent='#C6A0F6', accentHover='#B7BDF8')),

T('tokyo-night-storm', 'Tokyo Night Storm', 'dark', 'new', 'Tokyo Night under storm clouds.',
  """Tokyo Night Storm (github.com/enkia/tokyo-night-vscode-theme): the lighter,
bluer Tokyo Night. Terminal colours from the theme's own terminal.ansi* set;
its bright black (#414868) disappeared on the background and is lifted.""",
  ansi('#24283B', '#C0CAF5', '#C0CAF5', '#373D5A',
       ['#414868', '#F7768E', '#73DACA', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#8089B3'],
       ['#414868', '#F7768E', '#73DACA', '#E0AF68', '#7AA2F7', '#BB9AF7', '#7DCFFF', '#A9B1D6'],
       orange='#FF9E64', violet='#BB9AF7'),
  ui=dict(bg='#1F2335', bgSecondary='#24283B', surface='#24283B', surfaceHover='#292E42',
          textSecondary='#545C7E', accent='#7AA2F7')),

T('tokyo-night-light', 'Tokyo Night Light', 'light', 'new', 'Tokyo Night by day.',
  """Tokyo Night Light (github.com/enkia/tokyo-night-vscode-theme). Terminal
colours from the theme's terminal.ansi* set. Its bright black was the text
colour itself, so it now uses the theme's comment grey (#9699A3), darkened to
3.5:1 so autosuggestions stay dim but readable.""",
  ansi('#E6E7ED', '#343B58', '#363C4D', '#D7D9E1',
       ['#343B58', '#8C4351', '#33635C', '#8F5E15', '#2959AA', '#7B43BA', '#006C86', '#707280'],
       ['#9699A3', '#8C4351', '#33635C', '#8F5E15', '#2959AA', '#7B43BA', '#006C86', '#707280'],
       orange='#965027', violet='#7B43BA'),
  ui=dict(bg='#D6D8DF', bgSecondary='#E6E7ED', surface='#E6E7ED', surfaceHover='#DCDEE3',
          border='#C1C2C7', textSecondary='#707280', accent='#2959AA')),

T('monokai', 'Monokai', 'dark', 'new', 'The classic: hot pink, lime and olive black.',
  """Monokai as shipped with Visual Studio Code (extensions/theme-monokai).
Terminal and UI colours from that theme; its blended selection is flattened.
The darker normal red, blue and magenta are lifted to read on the background.
Hot pink is the accent.""",
  ansi('#272822', '#F8F8F2', '#F8F8F0', '#575A5A',
       ['#333333', '#C4265E', '#86B42B', '#B3B42B', '#6A7EC8', '#8C6BC8', '#56ADBC', '#E3E3DD'],
       ['#666666', '#F92672', '#A6E22E', '#E2E22E', '#819AFF', '#AE81FF', '#66D9EF', '#F8F8F2'],
       orange='#FD971F', violet='#AE81FF'),
  ui=dict(bg='#1E1F1C', bgSecondary='#272822', surface='#272822', surfaceHover='#3E3D32',
          border='#414339', accent='#F92672', accentHover='#AE81FF')),

T('night-owl', 'Night Owl', 'dark', 'new', 'For the night owls, by Sarah Drasner.',
  """Night Owl (github.com/sdras/night-owl-vscode-theme). Terminal colours from
the theme's terminal.ansi* set; bright black (#575656) was 2.4:1 and is
lifted. Deep navy UI, accent blue.""",
  ansi('#011627', '#D6DEEB', '#80A4C2', '#1D3B53',
       ['#011627', '#EF5350', '#22DA6E', '#C5E478', '#82AAFF', '#C792EA', '#21C7A8', '#FFFFFF'],
       ['#575656', '#EF5350', '#22DA6E', '#FFEB95', '#82AAFF', '#C792EA', '#7FDBCA', '#FFFFFF'],
       orange='#F78C6C', violet='#C792EA'),
  ui=dict(bg='#011627', accent='#82AAFF', accentHover='#7FDBCA')),

T('tomorrow-night', 'Tomorrow Night', 'dark', 'new', 'Chris Kempson\'s quiet classic.',
  """Tomorrow Night (github.com/chriskempson/tomorrow-theme). Uses the published
Tomorrow Night palette for normal colours (the repo's Xresources file has
much darker variants); bright black is the comment grey. Red is nudged up to
4.5:1.""",
  ansi('#1D1F21', '#C5C8C6', '#AEAFAD', '#373B41',
       ['#282A2E', '#CC6666', '#B5BD68', '#F0C674', '#81A2BE', '#B294BB', '#8ABEB7', '#C5C8C6'],
       ['#969896', '#CC6666', '#B5BD68', '#F0C674', '#81A2BE', '#B294BB', '#8ABEB7', '#FFFFFF'],
       orange='#DE935F', violet='#B294BB'),
  ui=dict(surfaceHover='#282A2E', border='#373B41', accent='#81A2BE', accentHover='#8ABEB7')),

T('one-light', 'One Light', 'light', 'new', 'One Dark\'s daytime twin.',
  """One Half Light (github.com/sonph/onehalf), the terminal port of Atom's One
Light. White was the background itself; it uses One Half's comment grey.
The accents are darkened within their hue for text on #FAFAFA.""",
  ansi('#FAFAFA', '#383A42', '#4F525D', '#BFCEFF',
       ['#383A42', '#E45649', '#50A14F', '#C18401', '#0184BC', '#A626A4', '#0997B3', '#A0A1A7'],
       ['#4F525D', '#DF6C75', '#98C379', '#E4C07A', '#61AFEF', '#C577DD', '#56B5C1', '#FFFFFF'],
       orange='#C18401', violet='#A626A4'),
  ui=dict(bg='#F0F0F0', bgSecondary='#FAFAFA', surface='#FAFAFA', border='#E5E5E5',
          accent='#0184BC')),

T('everforest-light', 'Everforest Light', 'light', 'new', 'Green-based, on warm paper.',
  """Everforest Light, medium (github.com/sainnhe/everforest). Same mapping as
Everforest Dark: bg layers for chrome, grey2 for bright black. Its accents and
foreground are pastel on paper (fg 5.2:1) and are darkened within their hue
to read as text.""",
  ansi('#FDF6E3', '#5C6A72', '#5C6A72', '#E6E2CC',
       ['#5C6A72', '#F85552', '#8DA101', '#DFA000', '#3A94C5', '#DF69BA', '#35A77C', '#939F91'],
       ['#829181', '#F85552', '#8DA101', '#DFA000', '#3A94C5', '#DF69BA', '#35A77C', '#BDC3AF'],
       orange='#F57D26', violet='#DF69BA'),
  ui=dict(bg='#F4F0D9', bgSecondary='#FDF6E3', surface='#FDF6E3', surfaceHover='#EFEBD4',
          border='#E0DCC7', textSecondary='#829181', accent='#8DA101', accentHover='#35A77C')),

T('vscode-dark', 'VS Code Dark', 'dark', 'new', 'Visual Studio Code\'s Dark Modern.',
  """Visual Studio Code's Dark Modern: terminal colours as published in Windows
Terminal's "VSCode Dark Modern" scheme, UI from VS Code's dark_modern theme.
Red, blue, magenta and bright black were under target on #1F1F1F and are
lifted.""",
  ansi('#1F1F1F', '#CCCCCC', '#FFFFFF', '#264F78',
       ['#000000', '#CD3131', '#0DBC79', '#E5E510', '#2472C8', '#BC3FBC', '#11A8CD', '#E5E5E5'],
       ['#666666', '#F14C4C', '#23D18B', '#F5F543', '#3B8EEA', '#D670D6', '#29B8DB', '#E5E5E5']),
  ui=dict(bg='#181818', bgSecondary='#1F1F1F', surface='#1F1F1F', border='#2B2B2B',
          textSecondary='#9D9D9D', accent='#4DAAFC')),

T('vscode-light', 'VS Code Light', 'light', 'new', 'Visual Studio Code\'s Light Modern.',
  """Visual Studio Code's Light Modern: terminal colours as published in Windows
Terminal's "VSCode Light Modern" scheme, UI from VS Code's light_modern theme.
Green and yellow were too light for text on white and are darkened.""",
  ansi('#FFFFFF', '#3B3B3B', '#005FB8', '#ADD6FF',
       ['#000000', '#CD3131', '#00BC00', '#949800', '#0451A5', '#BC05BC', '#0598BC', '#555555'],
       ['#666666', '#CD3131', '#14CE14', '#B5BA00', '#0451A5', '#BC05BC', '#0598BC', '#A5A5A5']),
  ui=dict(bg='#F8F8F8', bgSecondary='#FFFFFF', surface='#FFFFFF', surfaceHover='#F2F2F2',
          border='#E5E5E5', accent='#005FB8')),
]

# Where each ported palette comes from and under which licence. gen.py writes
# the credit into every theme YAML (the YAMLs are bundled raw, so it ships in
# the app) and builds THIRD_PARTY_NOTICES.md from this table. Every theme
# outside the 'axn' group must have an entry.
UPSTREAM = {
    'ayu':        ('Ayu', 'https://github.com/ayu-theme/ayu-colors', 'MIT',
                   'Copyright (c) Konstantin Pschera <me@kons.ch>'),
    'catppuccin': ('Catppuccin', 'https://github.com/catppuccin/palette', 'MIT',
                   'Copyright (c) 2021 Catppuccin'),
    'dracula':    ('Dracula', 'https://github.com/dracula/dracula-theme', 'MIT',
                   'Copyright (c) 2023 Dracula Theme'),
    'github':     ('GitHub VS Code theme + Primer primitives', 'https://github.com/primer/github-vscode-theme', 'MIT',
                   'Copyright (c) 2020 Primer; Copyright (c) 2018 GitHub Inc.'),
    'gruvbox':    ('Gruvbox', 'https://github.com/morhetz/gruvbox', 'MIT',
                   'Copyright (c) morhetz <morhetz@gmail.com>'),
    'one-dark':   ('One Dark (Atom)', 'https://github.com/atom/one-dark-syntax', 'MIT',
                   'Copyright (c) 2016 GitHub Inc.'),
    'onehalf':    ('One Half', 'https://github.com/sonph/onehalf', 'MIT',
                   'Copyright (c) 2019 Son A. Pham <sp@sonpham.me>'),
    'solarized':  ('Solarized', 'https://github.com/altercation/solarized', 'MIT',
                   'Copyright (c) 2011 Ethan Schoonover'),
    'tokyo-night': ('Tokyo Night', 'https://github.com/enkia/tokyo-night-vscode-theme', 'MIT',
                    'Copyright (c) 2018-present Enkia'),
    'nord':       ('Nord', 'https://github.com/nordtheme/nord', 'MIT',
                   'Copyright (c) 2016-present Sven Greb <development@svengreb.de>'),
    'rose-pine':  ('Rosé Pine', 'https://github.com/rose-pine/palette', 'MIT',
                   'Copyright (c) mvllow; Copyright (c) 2023 Rosé Pine'),
    'kanagawa':   ('Kanagawa', 'https://github.com/rebelot/kanagawa.nvim', 'MIT',
                   'Copyright (c) 2021 Tommaso Laurenzi'),
    'everforest': ('Everforest', 'https://github.com/sainnhe/everforest', 'MIT',
                   'Copyright (c) 2019 sainnhe'),
    'vscode':     ('Visual Studio Code', 'https://github.com/microsoft/vscode', 'MIT',
                   'Copyright (c) 2015 - present Microsoft Corporation'),
    'windows-terminal': ('Windows Terminal', 'https://github.com/microsoft/terminal', 'MIT',
                         'Copyright (c) Microsoft Corporation'),
    'night-owl':  ('Night Owl', 'https://github.com/sdras/night-owl-vscode-theme', 'MIT',
                   'Copyright (c) 2018 Sarah Drasner'),
    'tomorrow':   ('Tomorrow', 'https://github.com/chriskempson/tomorrow-theme', 'MIT',
                   'Copyright (c) 2011 Chris Kempson'),
}

# theme id -> UPSTREAM keys it draws on
SOURCES = {
    'ayu-dark': ['ayu'], 'ayu-light': ['ayu'],
    'catppuccin-latte': ['catppuccin'], 'catppuccin-mocha': ['catppuccin'],
    'catppuccin-frappe': ['catppuccin'], 'catppuccin-macchiato': ['catppuccin'],
    'dracula': ['dracula'], 'gruvbox-dark': ['gruvbox'], 'gruvbox-light': ['gruvbox'],
    'one-dark': ['one-dark'], 'one-light': ['onehalf'],
    'solarized-dark': ['solarized'], 'solarized-light': ['solarized'],
    'tokyo-night': ['tokyo-night'], 'tokyo-night-storm': ['tokyo-night'],
    'tokyo-night-light': ['tokyo-night'],
    'nord': ['nord'], 'rose-pine': ['rose-pine'], 'rose-pine-dawn': ['rose-pine'],
    'kanagawa': ['kanagawa'], 'everforest-dark': ['everforest'], 'everforest-light': ['everforest'],
    'github-dark': ['github'], 'github-light': ['github'],
    'monokai': ['vscode'], 'vscode-dark': ['windows-terminal', 'vscode'],
    'vscode-light': ['windows-terminal', 'vscode'],
    'night-owl': ['night-owl'], 'tomorrow-night': ['tomorrow'],
}
