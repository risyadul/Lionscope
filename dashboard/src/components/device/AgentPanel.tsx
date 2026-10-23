import { CopyButton } from '../stalls/CopyButton.tsx';
import './agent.css';

/** The one-client opt-in from the README's "Letting an agent operate the device". */
export const AGENT_DEVICE_COMMAND = 'claude mcp add lionscope -- npx -y lionscope mcp --allow-device-control';
export const AGENTS_DOCS_URL = 'https://github.com/risyadul/Lionscope#use-with-ai-agents';

/** Beside the device in the Device view: how to let an AI agent operate it, and what to keep in mind. */
export function AgentPanel() {
  return (
    <section className="agent-panel" aria-labelledby="agent-panel-title">
      <p className="overline">AI agents</p>
      <h2 id="agent-panel-title" className="agent-panel-title">
        Let an agent operate this device
      </h2>
      <p>
        Agents connected over MCP can read the screen's elements, tap, swipe, type and launch apps. Device
        tools are off by default; turn them on for one client:
      </p>
      <div className="agent-snippet">
        <div className="agent-snippet-bar">
          <span className="overline">Claude Code</span>
          <CopyButton text={() => AGENT_DEVICE_COMMAND} label="Copy" ariaLabel="Copy the command" />
        </div>
        <pre className="mono">{AGENT_DEVICE_COMMAND}</pre>
      </div>
      <p>
        Every tap shows up live on this screen. For Cursor, VS Code, Codex and other clients, see{' '}
        <a href={AGENTS_DOCS_URL} target="_blank" rel="noopener noreferrer">
          Use with AI agents
        </a>
        .
      </p>
      <p className="agent-panel-note">
        An agent with device control can do anything you could with the device in your hand: keep it off while
        a phone with personal data is connected.
      </p>
    </section>
  );
}
