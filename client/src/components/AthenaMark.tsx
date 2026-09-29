import athenaMarkUrl from "../assets/athena-mark.png";

export function AthenaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? "athenaMark small" : "athenaMark"} aria-hidden="true">
      <img src={athenaMarkUrl} alt="" />
    </span>
  );
}
