import { LANDING } from "../landing-content";
import { Link } from "../router";

export function Landing() {
  const { hero, steps, audiences, reasons, outcomes, footer } = LANDING;
  return (
    <main className="landing">
      <section className="landing-hero">
        <h1>{hero.headline}</h1>
        <p className="landing-lede">{hero.lede}</p>
        <div className="landing-cta">
          <Link to={hero.primary.to} className="btn lg green">
            {hero.primary.label}
          </Link>
          <a href={`#${hero.secondary.anchor}`} className="btn lg ghost">
            {hero.secondary.label}
          </a>
        </div>
        <p className="landing-note">
          <span className="eyebrow">{hero.judgeLabel}</span>
          {hero.judgeNote}
        </p>
      </section>

      <section id={hero.secondary.anchor}>
        <h2>How it works</h2>
        <ol className="landing-steps">
          {steps.map((step, i) => (
            <li key={step.title}>
              <span className="step-no">{i + 1}</span>
              <b>{step.title}</b>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>Who it is for</h2>
        <div className="landing-audiences">
          {audiences.map((audience) => (
            <article className="card pad" key={audience.heading}>
              <span className="eyebrow">{audience.who}</span>
              <h3>{audience.heading}</h3>
              <ul>
                {audience.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2>Why it holds</h2>
        <ul className="landing-reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Outcomes</h2>
        <ul className="landing-outcomes">
          {outcomes.map((outcome) => (
            <li key={outcome.name}>
              <b>{outcome.name}</b>
              <span className={`pill ${outcome.status === "Live" ? "ok" : "new"}`}>{outcome.status}</span>
              <p>{outcome.line}</p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="landing-foot">
        <a href={footer.repoUrl} target="_blank" rel="noreferrer">
          {footer.repoLabel}
        </a>
        <span>{footer.note}</span>
      </footer>
    </main>
  );
}
