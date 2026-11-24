import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const locations = ['Angeles', 'Bacolod', 'Baguio', 'Cagayan de Oro', 'Castillejos', 'Cebu', 'Davao', 'Gumaca', 'Infanta']
const monasteries = [
  ...locations.map((city, index) => ({ name: `Discalced Carmelite Monastery of ${city}`, city, slug: city.toLowerCase().replaceAll(' ', '-'), sortOrder: index + 1 })),
  ...Array.from({ length: 14 }, (_, index) => ({ name: `Federation monastery ${String(index + 10).padStart(2, '0')}`, city: 'To be updated', slug: `federation-monastery-${String(index + 10).padStart(2, '0')}`, sortOrder: index + 10 })),
]
const faqs = [
  ['Can I truly give 100% anonymously?', 'Yes. If you choose Give Anonymously, your name is not shown on public acknowledgments or community reports. Contact details shared for a private receipt are used only for that purpose.'],
  ['How do I pay using GCash or Maya?', 'Choose GCash or Maya and send your offering to the account shown in the final step. Include the transfer reference so our team can reconcile the gift.'],
  ['How does becoming a Church Monthly Sponsor work?', 'Choose Monthly Blessing when selecting your offering. Transfers are manual, and your recurring intention helps communities plan formation and daily needs.'],
  ['What do the automated SMS and Email reminders look like?', 'Reminders are brief, respectful notes about your monthly intention. You can update your contact preference or opt out at any time.'],
  ['Can I change, pause, or cancel my monthly sponsorship anytime?', 'Yes. Monthly blessings are commitments, not automatic charges. Contact the Federation to update or pause future transfers.'],
  ['Will I receive an official church donation receipt?', 'You may request an acknowledgment receipt. Official tax documentation depends on the Federation’s current accreditation and will be confirmed directly.'],
]
const trainingUsers = [
  ['Sr Mary Ann of Jesus,ocd', 'srmaryann.carmel@gmail.com'],
  ['Sr. Augustine Maebelle Salem, OCD', 'maebellesalem@gmail.com'],
  ['Leynes,Keith Dave E.', 'kdleynes04@gmail.com'],
  ['Mylene Villapando', 'mylene.v18@gmail.com'],
  ['Muñez, Rubelyn T.', 'bingmunez@gmail.com'],
  ['Cataquis, Jake', 'jakecataquis12@gmail.com'],
  ['RODRIGUEZ OWEN Y.', 'owen.rod09@gmail.com'],
  ['N. Naparete Liezl', 'liezlnaparete@gmail.com'],
  ['Adrigado, mary joy', 'mj.adrigado@gmail.com'],
  ['MAG-USARA ANTHONY', 'tonymagusara21@gmail.com'],
  ['John Michael Mogello', 'jmmogello@gmail.com'],
  ['Richmond Pastrana', 'mondpastrana@gmail.com'],
  ['Rivera, Miguel', 'migsrivera98@gmail.com'],
  ['Rambuyon, Josh Andrei M.', 'joshrambuyon@gmail.com'],
  ['De Villa, Ceressa Marie P.', 'cess.devilla@gmail.com'],
  ['Carpizo, Kimzyre', 'kimzyre.c@gmail.com'],
  ['De Chavez, Reizel', 'reizeldc@gmail.com'],
  ['Gomez, Lianne Ashley', 'liannegomez15@gmail.com'],
  ['Cichon, Vincent', 'vincent.cichon@gmail.com'],
  ['MAKILING, JAYMAR T.', 'jaymarmakiling07@gmail.com'],
  ['Cichon, Van Harvy', 'vanharvy.c@gmail.com'],
  ['Bernaldez, Jorge', 'jorgebernaldez@gmail.com'],
  ['Tambis, Jefferson', 'jeff.tambis88@gmail.com'],
  ['GANACAN, NECHELLE', 'nechelleganacan@gmail.com'],
  ['James Bond', 'jbond007.ph@gmail.com'],
  ['Danica ethel jornales', 'danicajornales@gmail.com'],
  ['Sr Mary Ann of Jesus,OCD', 'maryannjesus.ocd@gmail.com'],
  ['Sr. Dulce Inlayo, OCD', 'srdulceinlayo@gmail.com'],
  ['ANDO, EL DEAN DRAVE D.', 'drave.ando@gmail.com'],
  ['Leynes,Shan David E.', 'shanleynes@gmail.com'],
  ['Badilla, Jonie', 'jonie.badilla@gmail.com'],
  ['Fallaria, Chris Lloyd A.', 'chrislloyd.f@gmail.com'],
  ['Lamboson, Justine', 'tinelamboson22@gmail.com'],
  ['Cheryl Carpina Saripa', 'cherylsaripa@gmail.com'],
  ['Neri Naparete Liezl', 'liezlneri@gmail.com'],
  ['Ruales, Faye Marie', 'fayeruales@gmail.com'],
  ['Calinisan', 'calinisan.family@gmail.com'],
  ['Cabangon,John Kenneth', 'jkcabangon@gmail.com'],
  ['Suplito, Rosemelinda L.', 'rosesuplito@gmail.com'],
  ['Celine Mae Villanueva', 'celine.v11@gmail.com'],
  ['Escarpe Janlester', 'lesterescarpe@gmail.com'],
  ['Calinisan Jhon Mclean', 'mcleancalinisan@gmail.com'],
  ['Marielle Rivera', 'yellerivera03@gmail.com'],
  ['Raven Faith Ricardo', 'ravenricardo@gmail.com'],
  ['Joanna Mae Ramos', 'joannaramos19@gmail.com'],
  ['Mariela Rivera', 'mariela.rivera@gmail.com'],
  ['Patricia Quiambao', 'patquiambao@gmail.com'],
  ['Princess Mickyla Villarin', 'kylavillarin@gmail.com'],
  ['Bryan Emanuel Carpizo', 'bryancarpizo@gmail.com'],
  ['Mariane Tolentino', 'yanetolentino@gmail.com'],
  ['Benjamin, Randel L.', 'randelbenjamin@gmail.com'],
  ['Mark Vincent Benjamin', 'mvbenjamin@gmail.com'],
] as const

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if ((email && !password) || (!email && password)) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD to seed the administrator account.')
  }
  if (password && password.length < 16) {
    throw new Error('ADMIN_PASSWORD must contain at least 16 characters.')
  }
  if (email && password) {
    const passwordHash = await bcrypt.hash(password, 10)
    await prisma.user.upsert({ where: { email }, update: { name: process.env.ADMIN_NAME || 'Federation Administrator', passwordHash, role: 'ADMIN', isActive: true }, create: { name: process.env.ADMIN_NAME || 'Federation Administrator', email, passwordHash, role: 'ADMIN' } })
  } else {
    console.warn('Admin seed credentials are unset; skipping admin account seed.')
  }
  const trainingPasswordHash = await bcrypt.hash('12345678', 10)
  for (const [name, accountEmail] of trainingUsers) {
    await prisma.user.upsert({
      where: { email: accountEmail },
      update: {
        name,
        passwordHash: trainingPasswordHash,
        role: 'USER',
        isActive: true,
        privacyConsentAt: new Date('2026-11-24T00:00:00.000Z'),
        privacyPolicyVersion: 'training-dataset-v1',
      },
      create: {
        name,
        email: accountEmail,
        passwordHash: trainingPasswordHash,
        role: 'USER',
        isActive: true,
        privacyConsentAt: new Date('2026-11-24T00:00:00.000Z'),
        privacyPolicyVersion: 'training-dataset-v1',
      },
    })
  }
  for (const monastery of monasteries) {
    await prisma.monastery.upsert({ where: { slug: monastery.slug }, update: { ...monastery }, create: monastery })
  }
  const pages = [
    { pageKey: 'HOME', blocks: [{ title: 'Carmels in Communion', body: 'Welcome to the official website of the Philippine Federation of Discalced Carmelite Nuns.' }] },
    { pageKey: 'ABOUT', blocks: [{ title: 'About Us', body: 'A structure of communion among 23 Carmelite monastery members.' }] },
    { pageKey: 'CARMELIFE', blocks: [{ title: 'Carmelife', body: 'A contemplative life rooted in prayer, sisterhood, and the search for God.' }] },
    { pageKey: 'CARMELIGHT', blocks: [{ title: 'Carmelights', body: 'Vocation stories and glimpses of life in Carmel.' }] },
    { pageKey: 'CONTACT', blocks: [{ title: 'Contact Us', body: 'We welcome your questions and messages.' }] },
  ]
  for (const page of pages) await prisma.pageContent.upsert({ where: { pageKey: page.pageKey }, update: { blocks: page.blocks }, create: page })
  for (const [sortOrder, [question, answer]] of faqs.entries()) {
    const existing = await prisma.fAQ.findFirst({ where: { question } })
    if (existing) await prisma.fAQ.update({ where: { id: existing.id }, data: { answer, sortOrder, isPublished: true } })
    else await prisma.fAQ.create({ data: { question, answer, sortOrder } })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
