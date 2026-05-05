type Props = {
  entries: string[];
};

export function ActivityFeed({ entries }: Props) {
  return (
    <div className="panel activityFeed">
      <div className="panelHeader">
        <h2>Memory</h2>
        <span>{entries.length}</span>
      </div>
      <div className="memoryRows">
        {entries.map((entry, index) => (
          <article key={`${index}-${entry.slice(0, 12)}`}>
            {entry}
          </article>
        ))}
        {entries.length === 0 && <p className="empty">No memory entries.</p>}
      </div>
    </div>
  );
}
