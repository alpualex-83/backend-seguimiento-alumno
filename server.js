require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
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
  const nombre = asegurarTexto(datos?.nombre);
  const apellidos = asegurarTexto(datos?.apellidos);
  const nombreCompleto =
    asegurarTexto(datos?.nombreCompleto) ||
    [nombre, apellidos].filter(Boolean).join(" ").trim();

  const genero = asegurarTexto(datos?.genero);
  const fechaNacimiento = asegurarTexto(datos?.fechaNacimiento);
  const cursoAula = asegurarTexto(datos?.cursoAula);
  const observacionesGenerales = asegurarTexto(datos?.observacionesGenerales);
  const observacionesFamilia = asegurarTexto(datos?.observacionesFamilia);
  const trimestre = asegurarTexto(datos?.trimestre);
  const estiloInforme = asegurarTexto(datos?.estiloInforme);

  let texto = `Alumno: ${nombre}
Nombre completo: ${nombreCompleto}
Género: ${genero}
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

app.post("/generar-informe", async (req, res) => {
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
      timeout: 45000,
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

app.post("/mejorar-informe", async (req, res) => {
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
      timeout: 45000,
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

app.post("/exportar-docx", async (req, res) => {
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

app.post("/exportar-pptx", async (req, res) => {
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