// Español (neutral, tú). Same shape as en.ts.
import { joinFacts, type LegalCtx } from './util.ts'
import type { ServerWords } from './en.ts'

export const es: ServerWords = {
  lines: {
    remembered: (f) => `Anotado: ${f}`,
    forgot: (n, q) => (n === 1 ? `1 dato olvidado sobre “${q}”` : `${n} datos olvidados sobre “${q}”`),
    scheduled: (name, when) => `Recordatorio “${name}” programado: ${when}`,
    scheduleUpdated: (name, next) => `Recordatorio “${name}” actualizado; el próximo: ${next}`,
    scheduleDeleted: () => 'Recordatorio eliminado',
    goalNew: (t) => `Nuevo objetivo: ${t}`,
    goalUpdated: (t, what) => `${t}: ${what || 'actualizado'}`,
    built: (t) => `Interfaz creada: ${t}`,
    renamed: (n) => `Nombre cambiado a ${n}`,
    reminderFired: (n) => `Recordatorio enviado: ${n}`,
    connected: (n) => `${n} conectado`,
    ideas: (titles) => `${titles.length} ${titles.length === 1 ? 'idea nueva' : 'ideas nuevas'}: ${titles.join('; ')}`,
    brief: (t) => `Resumen de la mañana: ${t}`,
    memoryUpdated: (facts) => `Memoria actualizada: ${joinFacts(facts, '; ')}`,
    needsYes: (n) => `${n} necesita tu permiso`,
    hasQuestion: (n) => `${n} tiene una pregunta`,
    done: (n) => `${n} ya terminó`,
    openToAnswer: 'Abre la app para responder',
    reminderDue: 'Ya es la hora.',
    assistant: 'Asistente',
  },
  status: {
    working: 'Trabajando…', background: (what) => `En segundo plano: ${what}…`, backgroundPrefix: 'En segundo plano',
    readingResults: 'Leyendo los resultados…', modelBusy: 'El modelo está ocupado, reintentando…', tidying: 'Ordenando el chat…', thinking: 'Pensando…',
    stepSep: ': ',
  },
  errors: {
    noKey: 'Todavía no tiene clave del modelo. Quien administra este asistente tiene que añadir una.',
    keyRefused: 'Se rechazó su clave del modelo. Quien administra este asistente tiene que cambiarla.',
    noCredit: 'La cuenta del modelo se quedó sin saldo. Quien administra este asistente tiene que recargarla.',
    busy: 'El modelo siguió ocupado durante varios minutos. Envíalo de nuevo.',
    generic: 'No se pudo completar: no logró conectar con su modelo. Envíalo de nuevo.',
  },
  tools: { bash: 'Ejecutando un comando', pwsh: 'Ejecutando un comando', read: 'Leyendo un archivo', write: 'Escribiendo un archivo', edit: 'Editando un archivo', str_replace_editor: 'Editando un archivo', fs_search: 'Buscando archivos', grep: 'Buscando archivos', glob: 'Buscando archivos', web_search: 'Buscando en internet', web_fetch: 'Leyendo una página web', present: 'Preparando un archivo', todo: 'Actualizando el plan', schedule_create: 'Creando un recordatorio', schedule_update: 'Cambiando un recordatorio', schedule_delete: 'Eliminando un recordatorio', schedule_list: 'Revisando los recordatorios', subagent: 'Trabajando en una subtarea', subagent_fork: 'Pasando esto a segundo plano', send_message: 'Avisando a la tarea en segundo plano', interrupt_agent: 'Deteniendo la tarea en segundo plano', list_agents: 'Revisando las tareas en segundo plano', skill: 'Usando una habilidad', mcp__bot__remember: 'Anotando', mcp__bot__forget: 'Olvidando', mcp__bot__schedule_create: 'Creando un recordatorio', mcp__bot__schedule_update: 'Cambiando un recordatorio', mcp__bot__schedule_delete: 'Eliminando un recordatorio', mcp__bot__schedule_list: 'Revisando los recordatorios', mcp__bot__goal_set: 'Fijando un objetivo', mcp__bot__goal_update: 'Actualizando un objetivo', mcp__bot__goal_list: 'Revisando los objetivos', mcp__bot__notify: 'Avisándote', mcp__bot__set_my_name: 'Cambiando mi nombre', mcp__bot__show: 'Mostrándote una tarjeta', mcp__bot__ui: 'Creando una interfaz', mcp__browser__browser_navigate: 'Abriendo una página web', mcp__browser__browser_click: 'Haciendo clic en la página', mcp__browser__browser_type: 'Escribiendo en la página', mcp__browser__browser_take_screenshot: 'Haciendo una captura de pantalla', mcp__browser__browser_snapshot: 'Leyendo la página', mcp__browser__browser_evaluate: 'Leyendo la página', read_image: 'Mirando una captura de pantalla' },
  toolUsing: (service) => `Usando ${service}`,
  toolFallback: 'Trabajando',
  oauth: {
    service: 'Servicio', connected: (name) => `${name} está conectado`, notConnected: 'No conectado',
    goBack: 'Ya puedes volver a la app.', tryAgain: 'Vuelve a la app y toca Conectar otra vez.',
  },
  play: { done: 'Listo', back: 'Ya puedes volver a la app.', failed: 'No se pudo abrir esta interfaz.', opening: 'Abriendo…' },
  legal: {
    aiCompany: 'el proveedor de IA', aiModel: 'el modelo', hostingProvider: 'nuestro proveedor de alojamiento', itsPolicy: 'su política de privacidad',
    privacyTitle: 'Política de privacidad',
    privacy: (c: LegalCtx) => `<h1>Política de privacidad</h1><p class="muted">Boop · ${c.operator} · actualizada: ${c.updated}</p>
<p>Boop es un asistente en tu teléfono. Cuando inicias sesión, le damos a tu cuenta una computadora en la nube donde el asistente trabaja para ti. Esta página explica qué datos pasan por nosotros, quién los recibe, cuánto tiempo se guardan y cómo eliminarlos.</p>
<h2>Qué guardamos</h2><ul>
<li><b>Tu cuenta</b>: tu dirección de correo (con Iniciar sesión con Apple, el identificador de usuario y el correo que nos da Apple), un número de cuenta y los hashes de tus tokens de inicio de sesión.</li>
<li><b>Lo que hay en tu computadora</b>: tus conversaciones, lo que el asistente recuerda de ti, los archivos que crea, los recordatorios y objetivos, las interfaces que crea para ti, los inicios de sesión de los servicios que conectas y los datos de su navegador. Todo está en la computadora en la nube propia de tu cuenta; ninguna otra cuenta puede verlo.</li>
<li><b>Notificaciones</b>: el token de notificaciones de tu teléfono, para enviarte avisos.</li>
<li><b>Reportes</b>: el texto de una respuesta o el código de una interfaz que reportes, tu nota y tu número de cuenta.</li>
<li><b>Registros del servidor</b>: las horas de las solicitudes y los números de cuenta, para resolver problemas y evitar abusos.</li></ul>
<p>Sin anuncios, sin analíticas ni rastreo de terceros, y no vendemos ningún dato.</p>
<h2>Qué se envía al proveedor de IA</h2>
<p>Una vez que aceptas, <b>${c.company}</b>${c.policy} recibe tus mensajes, los archivos y páginas web que el asistente lee para una tarea y lo que recuerda de ti, y ejecuta <b>${c.model}</b> para escribir las respuestas. La app te lo pregunta antes del primer mensaje; puedes retirar tu consentimiento en cualquier momento en la app, en Ajustes → Proveedor de IA, y no se envía nada más.${c.filter ? ` Además, el servicio de moderación de <b>${c.filter}</b> revisa las respuestas; se oculta cualquier respuesta que marque.` : ''}</p>
<h2>Quién más recibe datos</h2><ul><li>${c.hosting}: ejecuta nuestros servidores y tu computadora en la nube.</li><li>Apple y Google: entregan las notificaciones.</li><li>Los servicios que conectas tú (por ejemplo, Notion o Gmail): el asistente los usa según le pidas; se aplican sus condiciones.</li></ul>
<p>Solo tratan los datos para ofrecer estas funciones, y les exigimos que los protejan al menos tan bien como lo hace esta política.</p>
<h2>Cuánto tiempo, y cómo eliminarlos</h2>
<p>Guardamos tus datos hasta que elimines tu cuenta. Elimínala en la app (Ajustes → Eliminar cuenta) o en la web, en <a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a>: eliminamos de inmediato tu computadora en la nube y su disco, el registro de tu cuenta y tus reportes. Las copias diarias del disco que hace nuestro proveedor de alojamiento caducan en un plazo de 5 días. No conservamos nada más, salvo que la ley lo exija.</p>
<h2>Tu propia computadora</h2><p>Si conectas la app a una computadora tuya, tus datos se quedan en ella y nunca nos llegan; solo nos llegan los reportes que decidas enviar.</p>
<h2>Seguridad</h2><p>Todo viaja por HTTPS; los tokens de inicio de sesión solo se guardan como hashes; la computadora de cada cuenta está separada de las demás.</p>
<h2>Edad</h2><p>Boop es para personas de 18 años o más.</p>
<h2>Contacto</h2><p>${c.contact}. Puedes pedirnos en cualquier momento ver, corregir o eliminar tus datos.</p>
`,
    termsTitle: 'Condiciones de uso',
    terms: (c: LegalCtx) => `<h1>Condiciones de uso</h1><p class="muted">Boop · ${c.operator} · actualizadas: ${c.updated}</p>
<h2>Quién puede usarlo</h2><p>Debes tener 18 años o más.</p>
<h2>Qué no está permitido</h2><p>No uses el asistente para crear, guardar o difundir: contenido sexual con menores o cualquier forma de explotación infantil; imágenes íntimas compartidas sin consentimiento; amenazas, acoso o intimidación; odio contra grupos protegidos; contenido que incite a la violencia, el terrorismo o las autolesiones o que los glorifique; ayuda concreta para actividades ilegales (incluidas armas, drogas y fraude); software malicioso; suplantar o engañar a otras personas; ni infringir la propiedad intelectual o la privacidad de otros.</p>
<h2>Reportes y qué hacemos</h2><p>Mantén pulsada una respuesta, o usa el menú de una interfaz, para reportarla. Actuamos sobre los reportes en un plazo de 24 horas y podemos eliminar u ocultar contenido, bloquear una interfaz, o suspender o cerrar una cuenta.</p>
<h2>La IA se equivoca</h2><p>Las respuestas las escribe una IA y pueden ser incorrectas. Comprueba lo que sea importante.</p>
<h2>Eliminar la cuenta</h2><p>Puedes eliminar tu cuenta en cualquier momento en la app o <a href="${c.hostUrl}/account/delete">en la web</a>. Consulta también la <a href="${c.hostUrl}/privacy${c.langQuery}">política de privacidad</a>.</p>
<h2>Contacto</h2><p>${c.contact}</p>`,
    deleteTitle: 'Eliminar tu cuenta de Boop', deleted: 'Eliminada',
    deletedBody: 'Si ese correo tenía una cuenta, se eliminó junto con su computadora en la nube, su disco y sus reportes (las copias del disco que hace nuestro proveedor de alojamiento caducan en un plazo de 5 días).',
    wrongCode: 'Ese código de acceso no es correcto.', tooMany: 'Demasiados intentos. Espera unos minutos.',
    deleteBody: 'Esto elimina tu cuenta, tu computadora en la nube y todo lo que contiene (conversaciones, memoria, archivos, interfaces, servicios conectados) y tus reportes, de inmediato y para siempre. También puedes hacerlo en la app: Ajustes → Eliminar cuenta.',
    emailPlaceholder: 'El correo con el que inicias sesión', codePlaceholder: 'Código de acceso', deleteButton: 'Eliminar cuenta', questions: '¿Preguntas?',
    openBody: 'Esta es una interfaz que el asistente creó para ti. Se abre en la app Boop: toca este enlace en un teléfono que tenga la app.',
    openInBrowser: 'Abrir Boop en el navegador',
  },
}
