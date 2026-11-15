# Android build image for the axn-term mobile app (Capacitor): Node +
# JDK 21 + Android SDK, running as the host user so artifacts come out
# owned by them.
ARG USER_ID=1000
ARG GROUP_ID=1000

FROM eclipse-temurin:21-jdk AS jdk

FROM node:22-slim

ARG USER_ID
ARG GROUP_ID

# Capacitor 8 requires Java 21.
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=${JAVA_HOME}/bin:${PATH}

# Google's Linux build-tools (aapt2, zipalign) ship x86-64 binaries only.
# On arm64 hosts the amd64 multiarch libs give binfmt/QEMU the x86 loader
# and runtime the binaries need — much more reliable than emulating the
# whole image (Node/Java under qemu-user segfaults).
RUN dpkg --add-architecture amd64 && \
    apt-get update && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    ca-certificates \
    git \
    rsync \
    libc6:amd64 \
    libstdc++6:amd64 \
    zlib1g:amd64 \
    && rm -rf /var/lib/apt/lists/*

# The workspace pins pnpm (package.json "packageManager").
RUN npm install -g pnpm@10.5.2

# Create the group/user only if they do not already exist; the base image
# already provides UID/GID 1000 (the built-in "node" user).
RUN if ! getent group "${GROUP_ID}" >/dev/null 2>&1; then \
        groupadd --gid "${GROUP_ID}" builder; \
    fi && \
    if ! getent passwd "${USER_ID}" >/dev/null 2>&1; then \
        useradd --uid "${USER_ID}" --gid "${GROUP_ID}" --shell /bin/bash --create-home builder; \
    fi

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=${ANDROID_HOME}
ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/36.0.0

RUN mkdir -p ${ANDROID_HOME} && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-12266719_latest.zip -O /tmp/cmdline-tools.zip && \
    mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip && \
    chown -R ${USER_ID}:${GROUP_ID} ${ANDROID_HOME}

# Cache/work dirs the build script mounts volumes on — created here so the
# volumes start out owned by the build user.
RUN mkdir -p /work /cache/pnpm /cache/gradle /cache/android /out && \
    chown -R ${USER_ID}:${GROUP_ID} /work /cache /out

USER ${USER_ID}

RUN yes | sdkmanager --licenses >/dev/null && \
    sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

WORKDIR /work
