require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const PptxGenJS = require("pptxgenjs");

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta OPENAI_API_KEY en variables de entorno.");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ------------------------------------------------------------------ */
/* Autenticación                                                       */
/* ------------------------------------------------------------------ */

/**
 * Inicializa Firebase Admin para poder verificar los tokens que envía la app.
 * La credencial se lee de FIREBASE_SERVICE_ACCOUNT, que admite el JSON de la
 * cuenta de servicio tal cual o codificado en base64.
 */
const inicializarFirebaseAdmin = () => {
  const bruto = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!bruto) {
    throw new Error(
      "Falta FIREBASE_SERVICE_ACCOUNT en variables de entorno. " +
        "Sin ella no se pueden verificar los usuarios y el backend quedaría abierto."
    );
  }

  const texto = bruto.trim().startsWith("{")
    ? bruto
    : Buffer.from(bruto, "base64").toString("utf8");

  const credenciales = JSON.parse(texto);

  admin.initializeApp({
    credential: admin.credential.cert(credenciales),
  });
};

inicializarFirebaseAdmin();

/**
 * Exige un token de Firebase válido. La app lo envía en la cabecera
 * Authorization. Sin esto, cualquiera con la URL podía gastar el crédito
 * de OpenAI.
 */
const exigirAutenticacion = async (req, res, next) => {
  const cabecera = req.headers.authorization || "";
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7).trim() : "";

  if (!token) {
    return crearErrorRespuesta(
      res,
      401,
      "Tu sesión no es válida. Cierra sesión y vuelve a entrar."
    );
  }

  try {
    const decodificado = await admin.auth().verifyIdToken(token);
    req.usuario = { uid: decodificado.uid, email: decodificado.email };
    next();
  } catch (error) {
    console.log("Token rechazado:", error?.code || error?.message);
    return crearErrorRespuesta(
      res,
      401,
      "Tu sesión ha caducado. Cierra sesión y vuelve a entrar."
    );
  }
};

/* ------------------------------------------------------------------ */
/* Límite de uso por usuario                                           */
/* ------------------------------------------------------------------ */

const VENTANA_LIMITE_MS = 60 * 60 * 1000; // 1 hora
const MAX_PETICIONES_POR_VENTANA = 60;

const usoPorUsuario = new Map();

// Limpieza periódica para que el mapa no crezca sin control.
setInterval(() => {
  const ahora = Date.now();
  for (const [uid, registro] of usoPorUsuario.entries()) {
    if (ahora - registro.inicio > VENTANA_LIMITE_MS) {
      usoPorUsuario.delete(uid);
    }
  }
}, VENTANA_LIMITE_MS).unref();

/**
 * Evita que una cuenta (propia o robada) dispare miles de llamadas a OpenAI.
 * 60 informes por hora es muy holgado para una maestra y muy poco para un abuso.
 */
const limitarUso = (req, res, next) => {
  const uid = req.usuario?.uid;
  if (!uid) return next();

  const ahora = Date.now();
  const registro = usoPorUsuario.get(uid);

  if (!registro || ahora - registro.inicio > VENTANA_LIMITE_MS) {
    usoPorUsuario.set(uid, { inicio: ahora, peticiones: 1 });
    return next();
  }

  registro.peticiones += 1;

  if (registro.peticiones > MAX_PETICIONES_POR_VENTANA) {
    console.log(`Límite alcanzado para el usuario ${uid}`);
    return crearErrorRespuesta(
      res,
      429,
      "Has generado muchos informes seguidos. Espera unos minutos e inténtalo de nuevo."
    );
  }

  next();
};

const rutaProtegida = [exigirAutenticacion, limitarUso];

const limpiarInforme = (texto) => {
  return String(texto || "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/__+/g, "")
    .replace(/`+/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
};

const asegurarTexto = (valor) => String(valor || "").trim();

const asegurarArray = (valor) => (Array.isArray(valor) ? valor : []);

const hayTextoUtil = (valor) => asegurarTexto(valor).length > 0;

const crearErrorRespuesta = (res, status, mensaje) => {
  return res.status(status).json({
    ok: false,
    error: mensaje,
  });
};

const construirTextoParaIA = (datos) => {
  // Solo el nombre de pila: los informes no llevan apellidos ni distinguen
  // entre niño y niña, porque para las educadoras es indiferente.
  const nombre = asegurarTexto(datos?.nombre);
  const rangoEdadAula = asegurarTexto(datos?.rangoEdadAula);
  const fechaNacimiento = asegurarTexto(datos?.fechaNacimiento);
  const cursoAula = asegurarTexto(datos?.cursoAula);
  const observacionesGenerales = asegurarTexto(datos?.observacionesGenerales);
  const observacionesFamilia = asegurarTexto(datos?.observacionesFamilia);
  const trimestre = asegurarTexto(datos?.trimestre);
  const estiloInforme = asegurarTexto(datos?.estiloInforme);

  let texto = `Alumno: ${nombre}
Edad del aula: ${rangoEdadAula || "No indicada"}
Fecha de nacimiento: ${fechaNacimiento || "No indicada"}
Curso / aula: ${cursoAula || "No indicado"}
Trimestre: ${trimestre}
Estilo de informe: ${estiloInforme}
`;

  if (observacionesGenerales) {
    texto += `Observaciones generales del alumno: ${observacionesGenerales}\n`;
  }

  if (observacionesFamilia) {
    texto += `Observaciones relevantes para la familia: ${observacionesFamilia}\n`;
  }

  texto += `\n`;

  asegurarArray(datos?.areas).forEach((area) => {
    const nombreArea = asegurarTexto(area?.nombre);
    const bloques = asegurarArray(area?.bloques);

    if (!nombreArea || bloques.length === 0) return;

    texto += `${nombreArea}:\n`;

    bloques.forEach((bloque) => {
      const nombreBloque = asegurarTexto(bloque?.nombre);
      const observacionBloque = asegurarTexto(bloque?.observacionBloque);
      const anotacionesBloque = asegurarArray(bloque?.anotacionesBloque);
      const items = asegurarArray(bloque?.items);

      const itemsConDatos = items.filter((item) => {
        return (
          asegurarTexto(item?.estado) !== "No observado" ||
          hayTextoUtil(item?.observacion) ||
          asegurarArray(item?.anotaciones).length > 0
        );
      });

      if (
        itemsConDatos.length === 0 &&
        !observacionBloque &&
        anotacionesBloque.length === 0
      ) {
        return;
      }

      texto += `  ${nombreBloque}:\n`;

      if (observacionBloque) {
        texto += `    Valoración final del bloque: ${observacionBloque}\n`;
      }

      if (anotacionesBloque.length > 0) {
        anotacionesBloque.forEach((a) => {
          texto += `    Anotación de bloque (${asegurarTexto(a?.fecha)}): ${asegurarTexto(a?.texto)}\n`;
        });
      }

      itemsConDatos.forEach((item) => {
        texto += `  - Ítem: ${asegurarTexto(item?.texto)}\n`;
        texto += `    Estado: ${asegurarTexto(item?.estado) || "No observado"}\n`;

        if (hayTextoUtil(item?.observacion)) {
          texto += `    Observación: ${asegurarTexto(item?.observacion)}\n`;
        }

        asegurarArray(item?.anotaciones).forEach((a) => {
          texto += `    Anotación (${asegurarTexto(a?.fecha)}): ${asegurarTexto(a?.texto)}\n`;
        });
      });
    });

    texto += `\n`;
  });

  return texto.trim();
};

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "backend-seguimiento-alumno",
    timestamp: new Date().toISOString(),
  });
});

const POLITICA_PRIVACIDAD_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Política de privacidad · Diario de Aula</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 20px 80px;
        line-height: 1.65;
        color: #0f172a;
      }
      h1 { font-size: 30px; margin-bottom: 4px; }
      h2 { font-size: 20px; margin-top: 34px; }
      .fecha { color: #64748b; font-size: 14px; margin-bottom: 28px; }
      .aviso {
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 12px;
        padding: 16px;
        margin: 24px 0;
      }
      table { border-collapse: collapse; width: 100%; margin-top: 12px; }
      th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; font-size: 15px; vertical-align: top; }
      th { background: #f1f5f9; }
      footer { margin-top: 48px; border-top: 1px solid #cbd5e1; padding-top: 20px; color: #64748b; font-size: 14px; }
      a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <h1>Política de privacidad</h1>
    <p class="fecha">Diario de Aula · Última actualización: 17 de agosto de 2026</p>

    <p>
      Diario de Aula es una aplicación dirigida a profesionales de la educación
      infantil para el seguimiento educativo de su alumnado y la elaboración de
      informes trimestrales. Esta política explica qué datos se tratan, con qué
      finalidad y qué derechos existen sobre ellos.
    </p>

    <div class="aviso">
      <strong>Quién es responsable de los datos.</strong> La maestra o el centro
      educativo que usa la aplicación es el responsable del tratamiento de los
      datos del alumnado que introduce. Diario de Aula actúa como encargado del
      tratamiento: proporciona la herramienta y almacena la información por
      cuenta de quien la introduce, siguiendo sus instrucciones.
    </div>

    <h2>Qué datos se tratan</h2>
    <table>
      <tr>
        <th>Dato</th><th>Para qué</th><th>Quién lo introduce</th>
      </tr>
      <tr>
        <td>Correo electrónico y contraseña</td>
        <td>Crear la cuenta e iniciar sesión</td>
        <td>La persona usuaria</td>
      </tr>
      <tr>
        <td>Nombre y apellidos del alumnado, fecha de nacimiento, aula</td>
        <td>Identificar a cada alumno en el seguimiento y en sus informes</td>
        <td>La persona usuaria</td>
      </tr>
      <tr>
        <td>Observaciones, valoraciones y anotaciones con fecha</td>
        <td>Registrar la evolución del alumnado y redactar los informes</td>
        <td>La persona usuaria</td>
      </tr>
      <tr>
        <td>Datos del aula y del centro, agenda de reuniones</td>
        <td>Organizar el trabajo y ajustar la redacción de los informes</td>
        <td>La persona usuaria</td>
      </tr>
    </table>

    <p>
      La aplicación no recoge datos directamente de los niños ni de sus familias:
      toda la información la escribe la persona docente. No se usan cookies de
      seguimiento, no hay publicidad y no se hace perfilado.
    </p>

    <h2>Quién trata los datos por nuestra cuenta</h2>
    <p>
      Para prestar el servicio recurrimos a los siguientes proveedores, que
      actúan como subencargados del tratamiento:
    </p>
    <table>
      <tr><th>Proveedor</th><th>Para qué</th><th>Dónde</th></tr>
      <tr>
        <td>Google Firebase (Google Ireland Ltd.)</td>
        <td>Autenticación de las cuentas y almacenamiento de los datos</td>
        <td>Unión Europea (Madrid)</td>
      </tr>
      <tr>
        <td>OpenAI, L.L.C.</td>
        <td>
          Redacción de los borradores de informe. Se le envía el texto que la
          maestra ha anotado, junto con el nombre de pila del alumno
          <strong>sin apellidos</strong>. No se usa para entrenar sus modelos.
        </td>
        <td>Estados Unidos, con cláusulas contractuales tipo</td>
      </tr>
      <tr>
        <td>Render, Inc.</td>
        <td>Alojamiento del servidor que genera los informes</td>
        <td>Estados Unidos, con cláusulas contractuales tipo</td>
      </tr>
    </table>

    <p>
      No vendemos datos personales ni los cedemos a terceros con fines
      comerciales.
    </p>

    <h2>Cuánto tiempo se conservan</h2>
    <p>
      Los datos permanecen mientras la cuenta esté activa. Desde la propia
      aplicación, en <em>Mi cuenta → Eliminar mi cuenta</em>, se pueden borrar de
      forma permanente la cuenta y todos los datos del alumnado asociados. El
      borrado es inmediato e irreversible, así que conviene exportar antes los
      informes que se quieran conservar.
    </p>

    <h2>Dónde se guardan</h2>
    <p>
      Los datos se almacenan en el dispositivo y en Google Firestore, en la
      región de Madrid (Unión Europea). Cada cuenta solo puede acceder a sus
      propios datos: las reglas de seguridad impiden que una persona usuaria vea
      la información de otra.
    </p>

    <h2>Derechos</h2>
    <p>
      Cualquier persona puede ejercer sus derechos de acceso, rectificación,
      supresión, limitación, portabilidad y oposición escribiendo a
      <a href="mailto:app@diarioaula.com">app@diarioaula.com</a>. Si el dato se
      refiere a un menor, la solicitud debe dirigirse en primer lugar al centro
      educativo, que es el responsable del tratamiento. También existe el derecho
      a reclamar ante la Agencia Española de Protección de Datos
      (<a href="https://www.aepd.es">aepd.es</a>).
    </p>

    <h2>Menores</h2>
    <p>
      La aplicación está destinada exclusivamente a personas adultas que trabajan
      en educación infantil. Los menores no crean cuentas ni usan la aplicación.
      Los datos del alumnado los introduce la persona docente en el ejercicio de
      su función educativa, y corresponde al centro informar a las familias y
      contar con la base legal adecuada.
    </p>

    <h2>Cambios en esta política</h2>
    <p>
      Si esta política cambia, se actualizará esta página y se indicará la fecha
      de la última modificación.
    </p>

    <footer>
      Contacto: <a href="mailto:app@diarioaula.com">app@diarioaula.com</a><br />
      <a href="/privacy?lang=en">Read this policy in English</a>
    </footer>
  </body>
</html>`;

const POLITICA_PRIVACIDAD_HTML_EN = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy · Diario de Aula</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        max-width: 760px; margin: 0 auto; padding: 40px 20px 80px;
        line-height: 1.65; color: #0f172a;
      }
      h1 { font-size: 30px; margin-bottom: 4px; }
      h2 { font-size: 20px; margin-top: 34px; }
      .fecha { color: #64748b; font-size: 14px; margin-bottom: 28px; }
      table { border-collapse: collapse; width: 100%; margin-top: 12px; }
      th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; font-size: 15px; vertical-align: top; }
      th { background: #f1f5f9; }
      footer { margin-top: 48px; border-top: 1px solid #cbd5e1; padding-top: 20px; color: #64748b; font-size: 14px; }
      a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <h1>Privacy Policy</h1>
    <p class="fecha">Diario de Aula · Last updated: 17 August 2026</p>

    <p>
      Diario de Aula is an application for early-childhood education
      professionals to track their pupils' development and write termly reports.
      This policy explains what data is processed, why, and what rights apply.
    </p>

    <p>
      <strong>Who controls the data.</strong> The teacher or school using the app
      is the data controller for the pupil information they enter. Diario de Aula
      acts as a data processor: it provides the tool and stores the information
      on their behalf and under their instructions.
    </p>

    <h2>What data is processed</h2>
    <table>
      <tr><th>Data</th><th>Purpose</th></tr>
      <tr><td>Email address and password</td><td>Account creation and sign-in</td></tr>
      <tr><td>Pupil first name and surname, date of birth, classroom</td><td>Identifying each pupil in their tracking and reports</td></tr>
      <tr><td>Observations, assessments and dated notes</td><td>Recording development and drafting reports</td></tr>
      <tr><td>Classroom and school details, meetings diary</td><td>Organising work and tailoring report wording</td></tr>
    </table>

    <p>
      The app does not collect data directly from children or families: all
      information is written by the teacher. There are no tracking cookies, no
      advertising and no profiling.
    </p>

    <h2>Processors</h2>
    <table>
      <tr><th>Provider</th><th>Purpose</th><th>Location</th></tr>
      <tr><td>Google Firebase (Google Ireland Ltd.)</td><td>Authentication and data storage</td><td>European Union (Madrid)</td></tr>
      <tr><td>OpenAI, L.L.C.</td><td>Drafting reports. It receives the notes written by the teacher and the pupil's first name <strong>without surnames</strong>. Not used to train their models.</td><td>United States, under standard contractual clauses</td></tr>
      <tr><td>Render, Inc.</td><td>Hosting the report-generation server</td><td>United States, under standard contractual clauses</td></tr>
    </table>

    <p>We do not sell personal data or share it for commercial purposes.</p>

    <h2>Retention and deletion</h2>
    <p>
      Data is kept while the account is active. From <em>My account → Delete my
      account</em> inside the app, the account and all associated pupil data can
      be permanently deleted. Deletion is immediate and irreversible, so export
      any reports you wish to keep beforehand.
    </p>

    <h2>Where data is stored</h2>
    <p>
      Data is stored on the device and in Google Firestore, in the Madrid region
      (European Union). Security rules ensure each account can only access its
      own data.
    </p>

    <h2>Your rights</h2>
    <p>
      To exercise rights of access, rectification, erasure, restriction,
      portability or objection, write to
      <a href="mailto:app@diarioaula.com">app@diarioaula.com</a>. Requests
      concerning a child should first be addressed to the school, which is the
      data controller. Complaints may also be filed with the Spanish Data
      Protection Agency (<a href="https://www.aepd.es">aepd.es</a>).
    </p>

    <h2>Children</h2>
    <p>
      The app is intended solely for adults working in early-childhood
      education. Children do not create accounts or use the app.
    </p>

    <footer>
      Contact: <a href="mailto:app@diarioaula.com">app@diarioaula.com</a><br />
      <a href="/privacy">Leer esta política en español</a>
    </footer>
  </body>
</html>`;

app.get("/privacy", (req, res) => {
  const enIngles = String(req.query.lang || "").toLowerCase() === "en";
  res.type("html").send(
    enIngles ? POLITICA_PRIVACIDAD_HTML_EN : POLITICA_PRIVACIDAD_HTML
  );
});

app.post("/generar-informe", ...rutaProtegida, async (req, res) => {
  try {
    const datosAlumno = req.body;

    if (!datosAlumno || typeof datosAlumno !== "object") {
      return crearErrorRespuesta(res, 400, "Datos de informe no válidos.");
    }

    if (!hayTextoUtil(datosAlumno?.nombre)) {
      return crearErrorRespuesta(res, 400, "Falta el nombre del alumno.");
    }

    if (!hayTextoUtil(datosAlumno?.trimestre)) {
      return crearErrorRespuesta(res, 400, "Falta el trimestre.");
    }

    if (!Array.isArray(datosAlumno?.areas)) {
      return crearErrorRespuesta(res, 400, "Las áreas del informe no son válidas.");
    }

    const promptUsuario = `
Redacta un informe trimestral oficial de escuela infantil, con nivel de centro educativo premium.

Debe estar escrito únicamente en párrafos fluidos y naturales.
No uses markdown.
No uses asteriscos.
No uses títulos con símbolos.
No uses listas ni viñetas.
No uses etiquetas técnicas.
No reproduzcas literalmente los ítems de evaluación: interprétalos y transfórmalos en redacción pedagógica real.

El informe debe transmitir:
- evolución durante el trimestre
- avances observados
- aspectos que continúan en proceso
- acompañamiento educativo
- cercanía con la familia
- refuerzo positivo
- autonomía progresiva

Integra con naturalidad:
- observaciones del educador
- anotaciones con fecha
- matices evolutivos
- tono profesional y humano

Ajusta lo que escribes a la edad del aula, si viene indicada. En 0-1 años
hablarás de sostén de la cabeza, sedestación, balbuceo o vínculo con el adulto;
en 1-2 años de marcha, primeras palabras y autonomía incipiente; en 2-3 años de
lenguaje en frases, juego simbólico, control de esfínteres y convivencia. No
menciones la edad como tal ni digas "para su edad": simplemente escribe sobre
lo que corresponde a ese momento del desarrollo.

Cómo referirte al alumno:
- Usa siempre su nombre de pila. Nunca escribas apellidos.
- No indiques si es niño o niña, ni con sustantivos ("el niño", "la alumna")
  ni con adjetivos o participios con marca de género.
- Redacta con fórmulas que no marquen género. Convierte los adjetivos en
  sustantivos o en verbos:
  "está contento" -> "disfruta" o "se le ve a gusto"
  "es autónomo" -> "muestra autonomía"
  "está muy participativo" -> "participa con ganas"
  "se muestra tranquilo" -> "mantiene la calma" o "transmite tranquilidad"
  "ha sido muy trabajador" -> "ha mostrado mucho esfuerzo"
- Alterna el nombre con el sujeto elíptico para que no resulte repetitivo:
  "Marcos reconoce sus emociones. Este trimestre ha ampliado su vocabulario."
- Esta regla es obligatoria: una sola palabra con marca de género invalida el
  informe. Antes de terminar, repásalo y sustituye las que se hayan colado.

Las anotaciones llevan la fecha en la que el educador las escribió y están
ordenadas de la más antigua a la más reciente. Respeta ese orden al redactar:
describe primero el punto de partida y después cómo fue evolucionando, de forma
que el informe refleje el recorrido del trimestre. Si dos anotaciones sobre lo
mismo se contradicen, la más reciente describe la situación actual y la anterior
sirve para mostrar el avance.

${
  datosAlumno.historial
    ? `Historial de evolución del alumno:

Ten en cuenta la evolución del alumno entre trimestres.
Detecta progresos, cambios de comportamiento, avances en autonomía y lenguaje.

Integra esta evolución de forma natural en el informe actual, sin mencionarla explícitamente como "historial".

${datosAlumno.historial}

`
    : ""
}${
      datosAlumno.modoPremium
        ? `Modo Premium IA activado:
redacta el informe con un nivel especialmente alto de calidad, fluidez y profundidad pedagógica.

`
        : ""
    }Datos del alumno:

${construirTextoParaIA(datosAlumno)}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
Eres un educador experto en escuela infantil y redactas informes trimestrales de alta calidad para un centro educativo premium.

El centro se caracteriza por:
- una relación cercana con los niños y sus familias
- una mirada respetuosa sobre el desarrollo individual
- el refuerzo positivo como eje educativo
- el acompañamiento de la autonomía progresiva de cada niño

Tu tarea es redactar informes trimestrales con calidad profesional real.

Normas obligatorias:
- escribe en español de España
- refiérete al alumno por su nombre de pila, nunca por sus apellidos
- no marques el género: ni "el niño" o "la niña", ni adjetivos o participios
  con género ("contento", "tranquila", "autónomo"). Usa sustantivos y verbos
  en su lugar ("muestra autonomía", "disfruta", "mantiene la calma")
- usa un tono humano, natural, elegante y profesional
- el texto debe sonar a educador con experiencia, nunca a máquina
- evita expresiones repetitivas y conectores forzados
- evita frases vacías o genéricas
- evita contradicciones pedagógicas
- integra de forma natural las observaciones y anotaciones con fecha
- cuando haya fechas, incorpóralas dentro del relato, con naturalidad
- no uses markdown
- no uses asteriscos
- no uses listas
- no uses viñetas
- no uses encabezados artificiales
- no uses títulos con símbolos
- no pongas etiquetas como “Área 1:” o “Bloque A:”
- no copies literalmente los ítems curriculares
- interpreta pedagógicamente la información y conviértela en lenguaje de informe real

Rigor: esto es un documento que leerá la familia y que forma parte del
expediente del niño. Por encima del estilo está la veracidad.
- Escribe únicamente a partir de la información que te dan. No inventes
  situaciones, anécdotas, frases del niño, nombres de compañeros ni fechas.
- Si hay poca información, redacta un informe más corto. Nunca rellenes con
  frases genéricas que valdrían para cualquier niño.
- No emitas diagnósticos ni uses etiquetas clínicas (retraso, déficit,
  trastorno, hiperactividad, inmadurez). Describe conductas observadas.
- No compares con otros niños, ni con la media del aula, ni con lo "esperable
  para su edad".
- Lo que aún no está conseguido se cuenta como recorrido, no como carencia:
  "va afianzando", "lo va logrando con acompañamiento", "está en camino de".
- No atribuyas causas a la familia ni al entorno si no aparecen en las
  observaciones, y no hagas pronósticos sobre el futuro del niño.
- Si un dato falta, omítelo en silencio: no escribas "no se dispone de
  información" ni menciones que faltan datos.

Estructura del texto:
- un primer párrafo breve de apertura sobre la evolución general del trimestre
- varios párrafos de desarrollo, cohesionados y fluidos, integrando las distintas áreas de aprendizaje con naturalidad
- un último párrafo de cierre con valoración global y línea de acompañamiento educativo
- no cierres con fórmulas hechas del tipo "en definitiva" o "en resumen"

Extensión y registro según el estilo:
- "Cercano": entre cuatro y seis párrafos, tono cálido y próximo a la familia,
  sin perder profesionalidad.
- "Formal": entre cuatro y seis párrafos, registro institucional, propio de un
  documento oficial de centro.
- "Breve": dos o tres párrafos. Conserva lo esencial de la evolución y quita el
  desarrollo secundario; que sea corto, no incompleto.

Si modoPremium está activado:
- redacta con un nivel de calidad superior
- utiliza una redacción más rica, matizada y elegante
- aumenta la cohesión entre párrafos
- aporta más profundidad pedagógica
- haz que el resultado sea excelente, no solo correcto

El resultado debe poder copiarse directamente en un informe oficial de escuela infantil de alto nivel.
          `.trim(),
        },
        {
          role: "user",
          content: promptUsuario,
        },
      ],
    });

    let informe = response.choices?.[0]?.message?.content?.trim() || "";
    informe = limpiarInforme(informe);

    if (!informe) {
      return crearErrorRespuesta(res, 502, "La IA no devolvió un informe válido.");
    }

    console.log("INFORME LIMPIO:\n", informe);

    res.json({ ok: true, informe });
  } catch (error) {
    console.error("=== ERROR GENERANDO INFORME ===");
    console.error(error?.message || error);
    console.error(error?.response?.data || "");
    console.error("===============================");

    res.status(500).json({
      ok: false,
      error: error?.message || "No se pudo generar el informe.",
    });
  }
});

app.post("/mejorar-informe", ...rutaProtegida, async (req, res) => {
  try {
    const { texto, estilo } = req.body;

    if (!texto || !texto.trim()) {
      return res.status(400).json({
        ok: false,
        error: "No hay texto para mejorar.",
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: `
Eres un educador experto en escuela infantil.

Tu tarea es mejorar la redacción de un informe ya existente.

Normas obligatorias:
- no cambies el contenido pedagógico
- no inventes información nueva
- no elimines datos relevantes ya presentes
- conserva el enfoque pedagógico y el tono del texto original
- mantén el sentido original del informe
- mejora fluidez, elegancia y coherencia
- elimina repeticiones
- hazlo más natural y humano
- tono profesional de centro educativo premium
- no usar markdown
- no usar asteriscos
- solo texto limpio en párrafos
- adapta el estilo según: ${estilo}

Además, al reescribir corrige estas cosas si aparecen en el original:
- referencias al alumno por apellidos: deja solo el nombre de pila
- cualquier marca de género, tanto en sustantivos ("el niño", "la alumna")
  como en adjetivos y participios ("contento", "tranquila", "autónomo").
  Sustitúyelos por fórmulas sin género: "muestra autonomía", "disfruta",
  "mantiene la calma". Esta corrección es obligatoria y debes repasar el texto
  entero antes de devolverlo.
- etiquetas clínicas o diagnósticos (retraso, déficit, trastorno, inmadurez):
  reescríbelos como conductas observadas
- comparaciones con otros niños o con lo "esperable para su edad": quítalas
- lo no conseguido formulado como carencia: pásalo a recorrido
  ("va afianzando", "lo va logrando con acompañamiento")

El resultado debe parecer escrito por un educador con experiencia.
          `.trim(),
        },
        {
          role: "user",
          content: `
Mejora este informe sin cambiar su contenido:

${texto}
          `.trim(),
        },
      ],
    });

    let informe = response.choices?.[0]?.message?.content?.trim() || "";
    informe = limpiarInforme(informe);

    if (!informe) {
      return crearErrorRespuesta(
        res,
        502,
        "La IA no devolvió una mejora válida del informe."
      );
    }

    res.json({ ok: true, informe });
  } catch (error) {
    console.error("=== ERROR MEJORANDO INFORME ===");
    console.error(error?.message || error);
    console.error(error?.response?.data || "");
    console.error("===============================");

    res.status(500).json({
      ok: false,
      error: error?.message || "No se pudo mejorar el informe.",
    });
  }
});

app.post("/exportar-docx", ...rutaProtegida, async (req, res) => {
  try {
    const alumno = asegurarTexto(req.body.alumno);
    const trimestre = asegurarTexto(req.body.trimestre);
    const estiloInforme = asegurarTexto(req.body.estiloInforme);
    const texto = limpiarInforme(asegurarTexto(req.body.texto));

    if (!texto) {
      return res.status(400).json({
        ok: false,
        error: "No hay texto para exportar.",
      });
    }

    const parrafos = texto
      .split("\n")
      .map((linea) => linea.trim())
      .filter((linea) => linea.length > 0);

    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: "Informe trimestral",
                  bold: true,
                  size: 32,
                }),
              ],
            }),
            new Paragraph({
              children: [new TextRun(`Alumno/a: ${alumno}`)],
            }),
            new Paragraph({
              children: [new TextRun(`Trimestre: ${trimestre}`)],
            }),
            new Paragraph({
              children: [new TextRun(`Estilo: ${estiloInforme}`)],
            }),
            new Paragraph({
              children: [
                new TextRun(
                  `Fecha de generación: ${new Date().toLocaleDateString("es-ES")}`
                ),
              ],
            }),
            new Paragraph({ children: [new TextRun("")] }),
            ...parrafos.map(
              (linea) =>
                new Paragraph({
                  children: [new TextRun(linea)],
                })
            ),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const base64 = buffer.toString("base64");

    res.json({
      ok: true,
      base64,
    });
  } catch (error) {
    console.error("=== ERROR EXPORTANDO DOCX ===");
    console.error(error?.message || error);
    console.error("============================");

    res.status(500).json({
      ok: false,
      error: error?.message || "No se pudo exportar el DOCX.",
    });
  }
});

app.post("/exportar-pptx", ...rutaProtegida, async (req, res) => {
  try {
    const alumno = asegurarTexto(req.body.alumno);
    const trimestre = asegurarTexto(req.body.trimestre);
    const estiloInforme = asegurarTexto(req.body.estiloInforme);
    const texto = limpiarInforme(asegurarTexto(req.body.texto));

    if (!texto) {
      return res.status(400).json({
        ok: false,
        error: "No hay texto para exportar.",
      });
    }

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "ChatGPT";
    pptx.subject = "Informe trimestral";
    pptx.title = `Informe ${alumno}`;
    pptx.company = "Centro educativo";
    pptx.lang = "es-ES";

    let bloques = texto
      .split("\n\n")
      .map((b) => b.trim())
      .filter(Boolean);

    if (bloques.length === 0) {
      bloques = [texto];
    }

    const bloquesNormalizados = [];
    let acumulado = "";

    for (const bloque of bloques) {
      const candidato = acumulado ? `${acumulado}\n\n${bloque}` : bloque;

      if (candidato.length <= 900) {
        acumulado = candidato;
      } else {
        if (acumulado) bloquesNormalizados.push(acumulado);
        acumulado = bloque;
      }
    }

    if (acumulado) {
      bloquesNormalizados.push(acumulado);
    }

    bloquesNormalizados.forEach((bloque, index) => {
      const slide = pptx.addSlide();

      slide.addText("Informe trimestral", {
        x: 0.6,
        y: 0.4,
        w: 11.5,
        h: 0.4,
        fontSize: 22,
        bold: true,
      });

      if (index === 0) {
        slide.addText(
          `Alumno/a: ${alumno}\nTrimestre: ${trimestre}\nEstilo: ${estiloInforme}`,
          {
            x: 0.8,
            y: 1.1,
            w: 5.8,
            h: 1.0,
            fontSize: 14,
            breakLine: false,
          }
        );

        slide.addText(bloque, {
          x: 0.8,
          y: 2.2,
          w: 11.0,
          h: 4.4,
          fontSize: 17,
          margin: 0.08,
          valign: "top",
          fit: "shrink",
        });
      } else {
        slide.addText(bloque, {
          x: 0.8,
          y: 1.1,
          w: 11.0,
          h: 5.5,
          fontSize: 18,
          margin: 0.08,
          valign: "top",
          fit: "shrink",
        });
      }
    });

    const buffer = await pptx.write({
      outputType: "nodebuffer",
    });

    const base64 = Buffer.from(buffer).toString("base64");

    res.json({
      ok: true,
      base64,
    });
  } catch (error) {
    console.error("=== ERROR EXPORTANDO PPTX ===");
    console.error(error?.message || error);
    console.error("============================");

    res.status(500).json({
      ok: false,
      error: error?.message || "No se pudo exportar el PPTX.",
    });
  }
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`Backend escuchando en puerto ${port}`);
});