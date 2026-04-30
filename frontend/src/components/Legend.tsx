import { colorForCategory } from "../lib/utils";

const categories = [
  ["core", "Core"],
  ["restroom", "Restroom"],
  ["water", "Water"],
  ["food", "Food"],
  ["info", "Info"],
  ["first_aid", "First aid"],
  ["shelter", "Shelter"],
  ["picnic", "Picnic"],
  ["recreation", "Recreation"],
  ["entrance", "Entrance / Gate"],
  ["other", "Other"]
] as const;

export default function Legend() {
  return (
    <section className="legend-card">
      <h3>Legend</h3>
      <div className="legend-grid">
        {categories.map(([key, label]) => (
          <div className="legend-item" key={key}>
            <span className="legend-swatch" style={{ background: colorForCategory(key) }} />
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="legend-note">Grey lines are walkable route segments. You can click them to choose start or destination.</p>
    </section>
  );
}
