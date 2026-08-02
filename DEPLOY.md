# Desplegar el backend con autenticación

El backend ya no acepta peticiones anónimas. Antes de subir estos cambios a
Render hay que crear una credencial de Firebase y añadirla como variable de
entorno. Si despliegas sin ella, el servidor **no arrancará** (falla a
propósito, para que nunca quede abierto sin darte cuenta).

## 1. Descargar la cuenta de servicio de Firebase

1. Entra en la [consola de Firebase](https://console.firebase.google.com/) y
   abre el proyecto `seguimiento-alumno`.
2. Icono del engranaje → **Configuración del proyecto**.
3. Pestaña **Cuentas de servicio**.
4. Botón **Generar nueva clave privada** → **Generar clave**.
5. Se descarga un archivo `.json`. **No lo subas a git.** Contiene una clave
   privada con acceso completo al proyecto.

## 2. Convertirlo a una sola línea

Render no acepta saltos de línea en las variables de entorno, así que lo
pasamos a base64. En tu terminal:

```bash
base64 -i ~/Downloads/seguimiento-alumno-XXXXX.json | tr -d '\n' | pbcopy
```

Eso deja el valor copiado en el portapapeles. (Si prefieres, también acepta el
JSON tal cual en una línea; el servidor detecta los dos formatos.)

## 3. Añadir la variable en Render

1. Abre tu servicio `backend-seguimiento-alumno` en Render.
2. **Environment** → **Add Environment Variable**.
3. Nombre: `FIREBASE_SERVICE_ACCOUNT`
4. Valor: pega lo que copiaste en el paso 2.
5. Guarda.

Comprueba que `OPENAI_API_KEY` sigue estando.

## 4. Desplegar

```bash
cd backend
npm install          # instala firebase-admin
git add .
git commit -m "proteger backend con verificacion de token de firebase"
git push
```

Render desplegará solo. Mira los logs: si ves
`Falta FIREBASE_SERVICE_ACCOUNT en variables de entorno`, revisa el paso 3.

## 5. Comprobar que funciona

Sin token debe rechazar la petición:

```bash
curl -s -X POST https://backend-seguimiento-alumno.onrender.com/generar-informe \
  -H "Content-Type: application/json" -d '{}'
```

Respuesta esperada:

```json
{"ok":false,"error":"Tu sesión no es válida. Cierra sesión y vuelve a entrar."}
```

Y desde la app, con sesión iniciada, generar un informe debe seguir funcionando
igual que antes.

> Importante: despliega el backend **antes o a la vez** que la nueva versión de
> la app. Una app antigua (sin token) contra el backend nuevo recibirá el error
> de sesión al generar informes.

## Qué protege esto

- **Verificación de token**: solo usuarios con cuenta en tu Firebase pueden usar
  los endpoints. Antes, cualquiera con la URL podía gastar tu crédito de OpenAI.
- **Límite de uso**: 60 peticiones por hora y usuario. Suficiente para una
  jornada de trabajo real, insuficiente para un abuso. Se ajusta en
  `MAX_PETICIONES_POR_VENTANA` dentro de `server.js`.

El límite se guarda en memoria. Si algún día pones más de una instancia en
Render, cada una llevará su propia cuenta; para ese caso habría que moverlo a
Redis o a Firestore.
