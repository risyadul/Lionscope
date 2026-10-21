import type { LogLevel } from '@lionscope/protocol/wire';
import { LOG_LEVEL_NAMES, LOG_LEVELS, levelRank } from '../../lib/logFilter.ts';
import { Segmented, type SegmentedOption } from '../ui/Segmented.tsx';

type Props = {
  minLevel: LogLevel;
  onChange: (level: LogLevel) => void;
};

/** Minimum-level selector: the chosen level and everything more severe stay lit. */
export function LevelFilter({ minLevel, onChange }: Props) {
  const minRank = levelRank(minLevel);
  const options: SegmentedOption<LogLevel>[] = LOG_LEVELS.map((level) => ({
    value: level,
    label: level,
    title: `${LOG_LEVEL_NAMES[level]} and above`,
    data: { 'data-level': level, 'data-included': levelRank(level) >= minRank ? 'true' : undefined },
  }));
  return (
    <Segmented
      className="level-filter"
      label="Minimum log level"
      options={options}
      value={minLevel}
      onChange={onChange}
    />
  );
}
