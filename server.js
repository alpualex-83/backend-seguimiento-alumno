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
  const fechaNacimiento = asegurarTexto(datos?.fechaNacimiento);
  const cursoAula = asegurarTexto(datos?.cursoAula);
  const observacionesGenerales = asegurarTexto(datos?.observacionesGenerales);
  const observacionesFamilia = asegurarTexto(datos?.observacionesFamilia);
  const trimestre = asegurarTexto(datos?.trimestre);
  const estiloInforme = asegurarTexto(datos?.estiloInforme);

  let texto = `Alumno: ${nombre}
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

app.get("/privacy", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Privacy Policy</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 40px auto;
            padding: 0 20px;
            line-height: 1.6;
            color: #111827;
          }
          h1 { font-size: 28px; }
          h2 { font-size: 20px; margin-top: 24px; }
        </style>
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p>This app collects user account data only for authentication and app functionality.</p>
        <p>No personal data is shared with third parties.</p>
        <p>Data is used exclusively to allow login, storage and educational tracking features inside the app.</p>
      </body>
    </html>
  `);
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

Estructura del texto:
- un primer párrafo breve de apertura sobre la evolución general del trimestre
- varios párrafos de desarrollo, cohesionados y fluidos, integrando las distintas áreas de aprendizaje con naturalidad
- un último párrafo de cierre con valoración global y línea de acompañamiento educativo

Si el estilo es "Breve", redacta una versión más concisa.
Si el estilo es "Formal", usa un tono más institucional.
Si el estilo es "Cercano", usa un tono más cálido sin perder profesionalidad.

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