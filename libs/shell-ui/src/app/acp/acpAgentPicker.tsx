import { pickOrCreate } from '../pickerHost';
import { resolveProcessIcon, type IconBag } from '../iconModel';
import { SessionIconGlyph } from '../iconGlyph';

/**
 * The "New agent session…" picker: the `acpAgents` entries from config.yaml
 * (name → command line) plus a create row accepting any command line (split
 * on whitespace). Row icons resolve through the icon bag keyed by the
 * executable (`customIcons: {vibe-acp: …}`), Bot otherwise. Returns the
 * chosen agent's argv, or null when dismissed.
 */
export async function pickAcpAgent(
  agents: Record<string, string>,
  bag: IconBag,
): Promise<string[] | null> {
  const result = await pickOrCreate({
    title: 'New agent session',
    placeholder: 'Search agents or type a command…',
    createLabel: (q) => `Custom agent command "${q}"`,
    items: Object.entries(agents).map(([label, command]) => ({
      key: command,
      label,
      detail: command,
      icon: (
        <SessionIconGlyph
          value={resolveProcessIcon(command.split(/\s+/)[0], bag, 'Bot')}
          className="h-3.5 w-3.5 shrink-0"
        />
      ),
    })),
  });
  if (!result) return null;
  return result.key.split(/\s+/).filter(Boolean);
}
