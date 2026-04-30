type Props = {
  search: string;
  setSearch: (value: string) => void;
};

export default function TopBar({ search, setSearch }: Props) {
  return (
    <div className="topbar">
      <div className="topbar__title">Central Park Navigation Website</div>
      <input
        className="topbar__search"
        placeholder="Search nodes, codes, or descriptions..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </div>
  );
}
