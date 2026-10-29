# Mosaico

Mosaico forms diverse, rotating student teams for each class activity. It mixes countries and careers, and keeps the same students from working together again and again. It was built for the MBA at Universidad Autónoma de Madrid (UAM) and can be reused by any program. Available in English and Spanish.

**Try it:** press **Demo** to explore the tool with fictional data. Nothing is saved.

## Features

- **Diverse teams:** countries and careers are spread across teams, even when one country is the majority.
- **New teammates:** pairs that already worked together are kept apart, especially if it was recent.
- **Fairness:** students who had less diverse teams before get priority next time.
- **Attendance:** absent students are left out of the round.
- **Manual adjustment:** swap or move students before saving, with undo.
- **Indicators:** country variety, career variety, and new teammates for every round.
- **PDF export** of the teams.

Careers written in different ways are grouped into areas, so *Computer Science*, *Informática*, and *Software Developer* all count as Engineering & technology.

### The algorithm

Each round splits the students present into teams of the chosen size and minimizes a cost with four terms:

1. **Country:** the Herfindahl index of each team, the sum of squared country shares. It is lowest when every member comes from a different country.
2. **Career:** the same index applied to career areas.
3. **Pair repetition:** how often each pair already worked together, with older rounds weighing less.
4. **Fairness:** students whose past teams were less diverse get priority for a diverse team now.

It starts by dealing students out by country, then improves the split with simulated annealing (random swaps between teams, keeping the ones that lower the cost). It runs in the browser in seconds. In **Advanced settings**, a slider sets the weight of each term.

## How it works

1. **Students:** add students one by one or import a list, one per line: `Name; Country; Career`.
2. **Teams:** mark today's attendance, choose the team size, and press **Generate teams**. Regenerate as many times as needed.
3. **Save the round:** choose the subject and date, and add an activity name if you like. Only saved rounds count as history.
4. **Download PDF.**

Each course keeps its own students and rounds.

## Profiles

| | Teacher | Coordinator | Admin |
|---|:-:|:-:|:-:|
| Form and save teams | Own subjects | All subjects | All subjects |
| Manage students, users, and subjects | | ✔ | ✔ |
| Can be assigned subjects | ✔ | ✔ | |

A coordinator has the same permissions as an admin and can teach subjects.

## Setup

Mosaico works with no setup: open `index.html` and data is kept in the browser. This is enough for a single device.

To share data across devices and teachers, with sign-in and profiles, Mosaico can connect to a database. The repository includes the schema (`schema.sql`), the user-management function, and a keep-alive workflow, ready for a Supabase project. Connecting it means running the schema, deploying the function, and filling `SB` in `index.html` with the project URL and its public key.

Accounts and subjects are then managed from the app itself. Initial staff and subjects can also be loaded with a private `seed.sql`, which is git-ignored: staff data never goes in the repository.

## Files

```
index.html          The whole app
schema.sql          Database tables and permissions
functions           User management for the Users tab
.github/workflows   Keep-alive ping
```

No build step. jsPDF, flag-icons, and supabase-js are loaded from a CDN with pinned versions.

## Security

The repository contains no secrets and no personal data. Permissions are enforced by the database, not only by the interface: without signing in nothing can be read, and a teacher never sees other teachers' accounts or assignments.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Oscar Poblete Sáenz. Redistributions must keep the [NOTICE](NOTICE) file.

The UAM logo belongs to its owners and is not covered by the license.
