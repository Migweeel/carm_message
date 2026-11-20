import legalDocuments from '../legal-pages.json'
import { Link } from 'react-router-dom'

type LegalDocument = typeof legalDocuments.privacy

function renderParagraph(text: string) {
  const email = 'ocdnuns.vocpromph@gmail.com'
  const emailIndex = text.indexOf(email)
  if (emailIndex < 0) return text
  return <>
    {text.slice(0, emailIndex)}
    <a href={`mailto:${email}`}>{email}</a>
    {text.slice(emailIndex + email.length)}
  </>
}

function PolicySections({ document }: { document: LegalDocument }) {
  return <div className="privacy-notice-content legal-policy-content">
    {document.sections.map((section) => <section key={section.heading}>
      <h3>{section.heading}</h3>
      {section.paragraphs.map((paragraph) => <p key={paragraph}>{renderParagraph(paragraph)}</p>)}
    </section>)}
  </div>
}

export function PrivacyNoticeContent() {
  return <div className="privacy-notice-content">
    <p>{legalDocuments.privacy.intro}</p>
    {legalDocuments.privacy.sections.map((section) => <section key={section.heading}>
      <h3>{section.heading}</h3>
      {section.paragraphs.map((paragraph) => <p key={paragraph}>{renderParagraph(paragraph)}</p>)}
    </section>)}
  </div>
}

function LegalPolicyPage({ document, relatedPath, relatedLabel }: {
  document: LegalDocument
  relatedPath: string
  relatedLabel: string
}) {
  return <article className="content-page section-wrap legal-policy-page">
    <span className="eyebrow">{document.eyebrow}</span>
    <h1>{document.title}</h1>
    <p className="page-lead">{document.intro}</p>
    <PolicySections document={document} />
    <p className="legal-policy-updated">Last updated: {document.lastUpdated}</p>
    <nav className="legal-policy-links" aria-label="Related legal pages">
      <Link to={relatedPath}>{relatedLabel}</Link>
      <Link to="/contact">Contact the Federation</Link>
    </nav>
  </article>
}

export function PrivacyPolicyPage() {
  return <LegalPolicyPage document={legalDocuments.privacy} relatedPath="/terms" relatedLabel="Terms of Service" />
}

export function TermsOfServicePage() {
  return <LegalPolicyPage document={legalDocuments.terms} relatedPath="/privacy" relatedLabel="Privacy Policy" />
}
