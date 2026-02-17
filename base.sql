-- Esquema base para demoAsistenteFisioDes (PostgreSQL)

CREATE TABLE Clientes (
    IdCliente INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    NombreCompleto VARCHAR(150) NOT NULL,
    NumeroCelular VARCHAR(30) NOT NULL,
    CorreoElectronico VARCHAR(150) NOT NULL UNIQUE
);

CREATE TABLE Especialistas (
    IdEspecialista INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    NombreCompleto VARCHAR(150) NOT NULL,
    CorreoElectronico VARCHAR(150),
    NumeroCelular VARCHAR(30)
);

CREATE TABLE Servicios (
    IdServicio INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    NombreServicio VARCHAR(150) NOT NULL,
    PrecioServicio DECIMAL(10, 2) NOT NULL,
    DuracionMinutos INT NOT NULL DEFAULT 60
);

CREATE TABLE Calendario (
    id_calendario INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_especialista INT NOT NULL,
    google_calendar_id VARCHAR(255) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_calendario_especialista
        FOREIGN KEY (id_especialista)
        REFERENCES Especialistas(IdEspecialista)
);

CREATE TABLE Horarios (
    IdHorario INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    IdCalendario INT NOT NULL,
    DiaSemana INT NOT NULL CHECK (DiaSemana BETWEEN 1 AND 7), -- 1=Lunes ... 7=Domingo
    HoraInicio TIME NOT NULL,
    HoraFin TIME NOT NULL,
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_horarios_calendario
        FOREIGN KEY (IdCalendario)
        REFERENCES Calendario(id_calendario)
);

CREATE TABLE Citas (
    IdCita INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    FechaRegistro TIMESTAMP NOT NULL,
    CodigoReserva VARCHAR(50) NOT NULL UNIQUE,
    IdCliente INT NOT NULL,
    IdEspecialista INT NOT NULL,
    IdServicio INT NOT NULL,
    FechaCita DATE NOT NULL,
    HoraCita TIME NOT NULL,
    Estado VARCHAR(30) NOT NULL,
    Observaciones VARCHAR(300),
    CONSTRAINT fk_citas_clientes
        FOREIGN KEY (IdCliente)
        REFERENCES Clientes(IdCliente),
    CONSTRAINT fk_citas_especialistas
        FOREIGN KEY (IdEspecialista)
        REFERENCES Especialistas(IdEspecialista),
    CONSTRAINT fk_citas_servicios
        FOREIGN KEY (IdServicio)
        REFERENCES Servicios(IdServicio)
);
